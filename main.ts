/**
 * 流程：
 * 1) 先巡检，失效/网络异常账号跳过（不为其生成发帖任务）
 * 2) 发帖任务数 = 正常浏览器数 × 发送天数 × 每天发帖数（必定满额入队）
 * 3) 关键词 / 文案 / 图片均按任务顺序循环
 */
import type { WorkflowRunConfig } from './config.types';
import {
  loadWorkflowManifest,
  loadWorkflowRunConfig,
  type AutomationRunResult,
  type WorkflowContext,
  XportWorkflowClient,
} from 'xport-workflow-sdk';

const CHECK_CMD = 'fb-auto-check' as const;
const POST_CMD = 'fb-keywords-group-post' as const;
const CONTENT_SEP = '==sep==';

function isAbnormalAccountStatus(status: unknown): boolean {
  const s = String(status ?? '').trim().toLowerCase();
  return s === 'invalid' || s === 'network';
}

function parseBrowserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
}

function asSwitch(raw: unknown, fallback: 0 | 1): 0 | 1 {
  if (raw === true || raw === 1 || raw === '1') return 1;
  if (raw === false || raw === 0 || raw === '0') return 0;
  return fallback;
}

function asText(raw: unknown, fallback = ''): string {
  if (raw == null) return fallback;
  return String(raw);
}

function splitLines(raw: unknown): string[] {
  return asText(raw, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitContentsBySep(raw: unknown): string[] {
  return asText(raw, '')
    .split(CONTENT_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseTimeToMinutes(raw: unknown, fallback: string): number {
  const text = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return 9 * 60;
  return Number(m[1]) * 60 + Number(m[2]);
}

function randomIntBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function localDayTimeSec(baseSec: number, dayOffset: number, minutesOfDay: number): number {
  const ref = new Date(baseSec * 1000);
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  const t = new Date(
    ref.getFullYear(),
    ref.getMonth(),
    ref.getDate() + dayOffset,
    hour,
    minute,
    0,
    0,
  );
  return Math.floor(t.getTime() / 1000);
}

function localDayStartSec(baseSec: number, dayOffset: number, dayStartMin: number): number {
  return localDayTimeSec(baseSec, dayOffset, dayStartMin);
}

function localDayEndSec(baseSec: number, dayOffset: number, dayEndMin: number): number {
  return localDayTimeSec(baseSec, dayOffset, dayEndMin);
}

function asResourceList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function asSingleResource(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return first ?? null;
  }
  return null;
}

function mediaTypeOf(raw: unknown): 'none' | 'image' | 'video' {
  const s = String(raw ?? 'none').trim().toLowerCase();
  if (s === 'image' || s === 'video') return s;
  return 'none';
}

/** 从池中按起始下标取 count 个，不足则循环 */
function takeCycled(pool: string[], startIndex: number, count: number): string[] {
  if (pool.length === 0 || count <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(pool[(startIndex + i) % pool.length]!);
  }
  return out;
}

function validateSchedule(cfg: WorkflowRunConfig): string | null {
  const duringMin = parsePositiveInt(cfg.during_min, 60);
  const duringMax = parsePositiveInt(cfg.during_max, 600);
  const dayStartMin = parseTimeToMinutes(cfg.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(cfg.daily_time_end, '18:00');
  if (dayStartMin >= dayEndMin) return '每日执行开始时刻须早于结束时刻';
  if (duringMin > duringMax) return '最小间隔不能大于最大间隔';
  return null;
}

/**
 * 为某账号某天生成 postsPerDay 个 planStartAt，保证条数；
 * 间隔优先 duringMin~duringMax，放不下则压缩到时间窗内仍满额。
 */
function planStartsForBrowserDay(
  nowSec: number,
  dayOffset: number,
  postsPerDay: number,
  duringMin: number,
  duringMax: number,
  dayStartMin: number,
  dayEndMin: number,
): number[] {
  const dayStart = localDayStartSec(nowSec, dayOffset, dayStartMin);
  const dayEnd = localDayEndSec(nowSec, dayOffset, dayEndMin);
  let cursor = dayOffset === 0 ? Math.max(nowSec, dayStart) : dayStart;
  if (cursor > dayEnd) cursor = dayEnd;

  const out: number[] = [];
  if (postsPerDay <= 0) return out;
  if (postsPerDay === 1) {
    out.push(cursor);
    return out;
  }

  let gap = randomIntBetween(duringMin, duringMax);
  const spanNeeded = gap * (postsPerDay - 1);
  const available = Math.max(0, dayEnd - cursor);
  if (spanNeeded > available) {
    gap = Math.max(1, Math.floor(available / (postsPerDay - 1)));
  }

  for (let s = 0; s < postsPerDay; s++) {
    const t = Math.min(cursor + s * gap, dayEnd);
    out.push(t);
  }
  return out;
}

async function runWorkflow(ctx: WorkflowContext, cfg: WorkflowRunConfig): Promise<AutomationRunResult> {
  const browserIds = parseBrowserIds(cfg.browsers);
  if (browserIds.length === 0) {
    return { succ: false, msg: '请至少选择一台浏览器账号' };
  }

  const keywords = splitLines(cfg.keywords);
  const contents = splitContentsBySep(cfg.contents);
  const postsPerDay = parsePositiveInt(cfg.group_count, 1);
  const runDays = parsePositiveInt(cfg.run_days, 1);
  const ensureEnglish = asSwitch(cfg.ensure_english, 0);
  const wantAnonymous = asSwitch(cfg.post_anonymously, 0);
  const wantJoin = asSwitch(cfg.join_group, 0);
  const mediaType = mediaTypeOf(cfg.media_type);
  const imagePool = asResourceList(cfg.images);
  const imageCount = parsePositiveInt(cfg.image_count, 1);
  const video = asSingleResource(cfg.video);
  const duringMin = parsePositiveInt(cfg.during_min, 60);
  const duringMax = parsePositiveInt(cfg.during_max, 600);
  const dayStartMin = parseTimeToMinutes(cfg.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(cfg.daily_time_end, '18:00');

  if (keywords.length === 0) return { succ: false, msg: '请至少填写一个关键词（每行一个）' };
  if (contents.length === 0) {
    return { succ: false, msg: '请填写发帖文案；多条用 ==sep== 分隔' };
  }
  if (mediaType === 'image' && imagePool.length === 0) {
    return { succ: false, msg: '媒体类型为图片时请上传图片' };
  }
  if (mediaType === 'video' && !video) {
    return { succ: false, msg: '媒体类型为视频时请上传视频' };
  }
  const scheduleErr = validateSchedule(cfg);
  if (scheduleErr) return { succ: false, msg: scheduleErr };

  // —— 阶段 1：巡检，筛出正常账号 ——
  let checked = 0;
  let skipped = 0;
  const skipNotes: string[] = [];
  const validBrowsers: number[] = [];

  ctx.workflowLog(
    `阶段1 巡检：共 ${browserIds.length} 台；发帖计划若全部正常则为 ${browserIds.length}×${runDays}×${postsPerDay}=${browserIds.length * runDays * postsPerDay}`,
  );

  for (let i = 0; i < browserIds.length; i++) {
    const browserId = browserIds[i]!;
    ctx.workflowLog(`巡检 ${i + 1}/${browserIds.length}: browserId=${browserId}`);

    const check = await ctx.runAutomation({
      cmd: CHECK_CMD,
      deviceId: browserId,
      target: 'browser',
      config: { ensure_english: ensureEnglish },
    });
    checked += 1;

    if (!check.succ) {
      skipped += 1;
      const reason = check.msg || '巡检任务失败';
      skipNotes.push(`browser#${browserId}: ${reason}`);
      ctx.workflowLog(`跳过 browserId=${browserId}（巡检失败，不生成发帖任务）：${reason}`);
      continue;
    }

    const accountStatus = check.data?.accountStatus;
    if (isAbnormalAccountStatus(accountStatus)) {
      skipped += 1;
      const label = accountStatus === 'network' ? '网络异常' : '失效账号';
      skipNotes.push(`browser#${browserId}: ${label}`);
      ctx.workflowLog(`跳过 browserId=${browserId}（${label}，仅打标签，不生成发帖任务）`);
      continue;
    }

    if (String(accountStatus ?? '').trim().toLowerCase() !== 'valid') {
      skipped += 1;
      const reason = `账号状态非正常（${String(accountStatus ?? 'unknown')}）`;
      skipNotes.push(`browser#${browserId}: ${reason}`);
      ctx.workflowLog(`跳过 browserId=${browserId}：${reason}`);
      continue;
    }

    validBrowsers.push(browserId);
  }

  const expectedPosts = validBrowsers.length * runDays * postsPerDay;
  ctx.workflowLog(
    `阶段2 发帖：正常账号 ${validBrowsers.length} 台；发帖任务数=${expectedPosts}（${validBrowsers.length}×${runDays}×${postsPerDay}）；关键词 ${keywords.length} / 文案 ${contents.length} / 图片 ${imagePool.length} 循环`,
  );

  if (validBrowsers.length === 0) {
    const summary = `巡检 ${checked} 台全部跳过，发帖任务数=0（公式按正常账号计）`;
    return {
      succ: false,
      msg: summary,
      data: {
        checked,
        skipped,
        valid_browsers: 0,
        expected_posts: 0,
        posted: 0,
        summary: skipNotes.length ? `${summary}；${skipNotes.join('；')}` : summary,
      },
    };
  }

  // —— 阶段 2：严格满额入队发帖任务 ——
  const nowSec = Math.floor(Date.now() / 1000);
  const keywordsPool = keywords.join('\n');
  let keywordIndex = 0;
  let contentIndex = 0;
  let imageIndex = 0;
  const postTaskIds: number[] = [];

  try {
    for (let day = 0; day < runDays; day++) {
      for (const browserId of validBrowsers) {
        const starts = planStartsForBrowserDay(
          nowSec,
          day,
          postsPerDay,
          duringMin,
          duringMax,
          dayStartMin,
          dayEndMin,
        );
        if (starts.length !== postsPerDay) {
          throw new Error(`排期异常：第 ${day + 1} 天 browser=${browserId} 应 ${postsPerDay} 条，实际 ${starts.length}`);
        }

        for (let slot = 0; slot < postsPerDay; slot++) {
          const planStartAt = starts[slot]!;
          const keyword = keywords[keywordIndex % keywords.length]!;
          keywordIndex += 1;
          const content = contents[contentIndex % contents.length]!;
          contentIndex += 1;

          let taskImages: string[] = [];
          let taskImageCount = 1;
          if (mediaType === 'image') {
            taskImages = takeCycled(imagePool, imageIndex, imageCount);
            imageIndex += imageCount;
            taskImageCount = taskImages.length;
          }

          const config = {
            keyword,
            keywords: keywordsPool,
            group_count: 1,
            content,
            post_anonymously: wantAnonymous,
            join_group: wantJoin,
            media_type: mediaType,
            images: taskImages,
            image_count: taskImageCount,
            video: mediaType === 'video' ? video : null,
          };

          const [enqOk, enqMsg, enqData] = await ctx.enqueueTask({
            cmd: POST_CMD,
            deviceId: browserId,
            target: 'browser',
            config,
            planStartAt,
          });
          if (!enqOk || !enqData?.taskId) {
            throw new Error(enqMsg || `入队发帖失败 browserId=${browserId}`);
          }
          postTaskIds.push(enqData.taskId);
          ctx.workflowLog(
            `发帖任务 ${postTaskIds.length}/${expectedPosts} #${enqData.taskId} browser=${browserId} day=${day + 1} slot=${slot + 1} keyword=${keyword}`,
          );
        }
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      succ: false,
      msg: reason,
      data: {
        checked,
        skipped,
        valid_browsers: validBrowsers.length,
        expected_posts: expectedPosts,
        posted: 0,
        summary: `${reason}（已入队发帖 ${postTaskIds.length}/${expectedPosts}）`,
      },
    };
  }

  if (postTaskIds.length !== expectedPosts) {
    const msg = `发帖任务数不符：应为 ${expectedPosts}=${validBrowsers.length}×${runDays}×${postsPerDay}，实际入队 ${postTaskIds.length}`;
    return {
      succ: false,
      msg,
      data: {
        checked,
        skipped,
        valid_browsers: validBrowsers.length,
        expected_posts: expectedPosts,
        posted: 0,
        summary: msg,
      },
    };
  }

  let posted = 0;
  let postFailed = 0;
  for (const taskId of postTaskIds) {
    const step = await ctx.waitForTask(taskId);
    if (step.succ) posted += 1;
    else {
      postFailed += 1;
      ctx.workflowLog(`发帖任务 #${taskId} 失败：${step.msg || 'unknown'}`);
    }
  }

  const summaryParts = [
    `巡检任务 ${checked}（跳过账号 ${skipped}）`,
    `正常账号 ${validBrowsers.length}`,
    `发帖任务 ${expectedPosts}=${validBrowsers.length}×${runDays}×${postsPerDay}`,
    `发帖成功 ${posted}`,
    `发帖失败 ${postFailed}`,
    `关键词循环 ${keywords.length}`,
    `文案循环 ${contents.length}`,
    mediaType === 'image' ? `图片循环 ${imagePool.length}` : null,
  ].filter(Boolean) as string[];
  if (skipNotes.length > 0) summaryParts.push(`跳过明细：${skipNotes.join('；')}`);
  const summary = summaryParts.join('；');

  return {
    succ: posted > 0,
    msg: posted > 0 ? `工作流完成：${summary}` : `没有发帖成功。${summary}`,
    data: {
      checked,
      skipped,
      valid_browsers: validBrowsers.length,
      expected_posts: expectedPosts,
      posted,
      summary,
    },
  };
}

const manifest = await loadWorkflowManifest();
const runConfig = await loadWorkflowRunConfig<WorkflowRunConfig>(manifest);

process.exit(
  await XportWorkflowClient.run((ctx) => runWorkflow(ctx, runConfig)),
);
