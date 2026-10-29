/**
 * 任务组分发：小组数 × 天数 × 浏览器数；关键词与文案均按顺序循环。
 *
 * 试跑：`{BUN} --no-env-file distribute.ts`
 */
import type { TaskGroupConfig } from './config.types';
import {
  type AutomationRunResult,
  type AutomationTaskManifest,
  localDayEndSec,
  localDayStartSec,
  parseBrowserDeviceIds,
  parsePositiveIntConfig,
  parseTimeToMinutes,
  randomIntBetween,
  splitConfigLines,
  type TaskCreateInput,
  validateTaskGroupScheduleConfig,
  XportBrowserAdminClient,
} from 'xport-browser-sdk';

/** 文案分隔符：单条可含换行，多条用 ==sep== 隔开。 */
const CONTENT_SEP = '==sep==';

function splitContentsBySep(raw: unknown): string[] {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  return text
    .split(CONTENT_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type PerBrowserScheduleState = {
  dayOffset: number;
  usedInDay: number;
  cursorSec: number;
};

function normalizeResources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

function normalizeMediaType(raw: unknown): 'none' | 'image' | 'video' {
  const v = String(raw ?? 'none').trim().toLowerCase();
  if (v === 'image' || v === 'video') return v;
  return 'none';
}

function rollBrowserToNextDay(baseSec: number, st: PerBrowserScheduleState, dayStartMin: number): void {
  st.dayOffset += 1;
  st.usedInDay = 0;
  st.cursorSec = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
}

/** 为当前任务准备排期：超日窗或已达当日每账号小组数则滚到下一天。 */
function prepareSlotForCurrentTask(
  baseSec: number,
  st: PerBrowserScheduleState,
  groupsPerDay: number,
  duringMin: number,
  dayStartMin: number,
  dayEndMin: number,
  maxDays: number,
): void {
  const maxDayRolls = Math.max(maxDays + 2, 32);
  let dayRolls = 0;
  for (;;) {
    if (st.dayOffset >= maxDays) {
      throw new Error(`schedule: exceeded run_days=${maxDays}`);
    }
    const dayStart = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
    const dayEnd = localDayEndSec(baseSec, st.dayOffset, dayEndMin);
    if (st.cursorSec < dayStart) st.cursorSec = dayStart;
    const exceedsDayEnd = st.cursorSec > dayEnd || st.cursorSec + duringMin > dayEnd;
    if (st.usedInDay >= groupsPerDay || exceedsDayEnd) {
      if (++dayRolls > maxDayRolls) {
        throw new Error('schedule: too many day rollovers (check during_min / time window / group_count)');
      }
      rollBrowserToNextDay(baseSec, st, dayStartMin);
      continue;
    }
    return;
  }
}

async function distributeGroup(ctx: {
  manifest: AutomationTaskManifest;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const keywords = splitConfigLines(groupConfig.keywords);
  const contents = splitContentsBySep(groupConfig.contents);
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);
  const groupCount = parsePositiveIntConfig(groupConfig.group_count, 1);
  const runDays = parsePositiveIntConfig(groupConfig.run_days, 1);
  const wantAnonymous = Number(groupConfig.post_anonymously) === 1 ? 1 : 0;
  const wantJoin = Number(groupConfig.join_group) === 1 ? 1 : 0;
  const mediaType = normalizeMediaType(groupConfig.media_type);
  const images = normalizeResources(groupConfig.images);
  const imageCount = parsePositiveIntConfig(groupConfig.image_count ?? 1, 1);
  const video =
    typeof groupConfig.video === 'string' && groupConfig.video.trim()
      ? groupConfig.video.trim()
      : null;

  if (keywords.length === 0) {
    return { succ: false, msg: 'no keywords in group config' };
  }
  if (contents.length === 0) {
    return { succ: false, msg: 'no captions in group config (contents); separate with ==sep== if multiple' };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: 'no browsers selected' };
  }
  if (groupCount < 1) {
    return { succ: false, msg: 'group_count must be at least 1' };
  }
  if (runDays < 1) {
    return { succ: false, msg: 'run_days must be at least 1' };
  }
  if (mediaType === 'image' && images.length === 0) {
    return { succ: false, msg: 'images required when media_type=image' };
  }
  if (mediaType === 'video' && !video) {
    return { succ: false, msg: 'video required when media_type=video' };
  }

  const duringMin = parsePositiveIntConfig(groupConfig.during_min, 60);
  const duringMax = parsePositiveIntConfig(groupConfig.during_max, 600);
  const dayStartMin = parseTimeToMinutes(groupConfig.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(groupConfig.daily_time_end, '18:00');
  const scheduleErrors = validateTaskGroupScheduleConfig(groupConfig);
  if (scheduleErrors.length > 0) {
    return { succ: false, msg: scheduleErrors.join('; ') };
  }

  // 总任务数 = 小组数 × 天数 × 浏览器数；每条子任务只发 1 个小组
  const expected = groupCount * runDays * browserIds.length;
  const nowSec = Math.floor(Date.now() / 1000);
  const perBrowserSchedule = new Map<number, PerBrowserScheduleState>();
  const tasks: TaskCreateInput[] = [];
  let keywordIndex = 0;
  let contentIndex = 0;

  try {
    for (let day = 0; day < runDays; day++) {
      for (const browserId of browserIds) {
        for (let g = 0; g < groupCount; g++) {
          const st =
            perBrowserSchedule.get(browserId) ??
            ({
              dayOffset: 0,
              usedInDay: 0,
              cursorSec: Math.max(nowSec, localDayStartSec(nowSec, 0, dayStartMin)),
            } satisfies PerBrowserScheduleState);

          while (st.dayOffset < day) {
            rollBrowserToNextDay(nowSec, st, dayStartMin);
          }

          prepareSlotForCurrentTask(
            nowSec,
            st,
            groupCount,
            duringMin,
            dayStartMin,
            dayEndMin,
            runDays,
          );

          const planStartAt = st.cursorSec;
          const keyword = keywords[keywordIndex % keywords.length]!;
          keywordIndex += 1;
          const content = contents[contentIndex % contents.length]!;
          contentIndex += 1;

          const config: Record<string, unknown> = {
            keyword,
            // 全量关键词池：单次任务无结果时按序切换，直到凑满发帖数
            keywords: keywords.join('\n'),
            group_count: 1,
            content,
            post_anonymously: wantAnonymous,
            join_group: wantJoin,
            media_type: mediaType,
            images: mediaType === 'image' ? images : [],
            image_count: mediaType === 'image' ? imageCount : 1,
            video: mediaType === 'video' ? video : null,
          };

          tasks.push({
            gid,
            cmd: manifest.cmd,
            deviceId: browserId,
            target: manifest.target,
            config,
            planStartAt,
          });

          st.usedInDay += 1;
          st.cursorSec = planStartAt + randomIntBetween(duringMin, duringMax);
          perBrowserSchedule.set(browserId, st);
        }
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { succ: false, msg: reason };
  }

  if (tasks.length === 0) {
    return { succ: false, msg: 'no tasks generated' };
  }
  if (tasks.length !== expected) {
    return {
      succ: false,
      msg: `expected ${expected} tasks (group_count×run_days×browsers) but got ${tasks.length}`,
    };
  }

  return {
    succ: true,
    msg: `generated ${tasks.length} tasks (groups=${groupCount} × days=${runDays} × browsers=${browserIds.length}; keywords cycle=${keywords.length}; captions cycle=${contents.length})`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
