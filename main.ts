/**
 * Facebook 关键词搜小组并发帖：
 * 打开小组搜索 → 收集结果 → 随机进组 →（可选）加入 → 多语发帖入口 → 文案 + 可选图/视频。
 * 控件文案随指纹浏览器界面语言变化：发帖入口/发布/加入/知道了 覆盖常见语种兜底。
 */
import type { TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  parsePositiveIntConfig,
  splitConfigLines,
  XportBrowserClient,
} from 'xport-browser-sdk';

/** 设备文字标签：账号风控受限（可筛设备；勿用 category）。 */
const RESTRICTED_ACCOUNT_LABEL = '受限账号';

const socialHome = () =>
  String(Bun.env.SOCIAL_HOME || 'https://www.facebook.com').replace(/\/$/, '');

/** 小组发帖入口：勿 `.one()`（视口过滤会误判为 0）。多语言文案子串兜底（仅含当场观察过的文案）。 */
const openComposerPath = nodePath()
  .css('div[role="button"]')
  .containAnyText(
    'Write something',
    "What's on your mind",
    '写点什么',
    '寫點什麼',
    // 繁中小组 Discussion：现场「寫點內容......」（非「寫點什麼」）
    '寫點內容',
    '有什么新鲜事',
    '有什麼新鮮事',
    'No que você está pensando',
    'Em que estás a pensar',
    'Escreva algo',
    'Escreve algo',
    'Escribe algo',
    '¿Qué estás pensando',
    'Que estas pensando',
    'Écrivez quelque chose',
    'Que voulez-vous dire',
    'À quoi pensez-vous',
    // 法语小组 Discussion：现场「Exprimez-vous...」
    'Exprimez-vous',
    'Schreib etwas',
    'Was machst du gerade',
    'Scrivi qualcosa',
    'A cosa stai pensando',
    'Напишите что-нибудь',
    'Что у вас нового',
    '何か書きましょう',
    '今どうしてる',
    '무슨 생각을 하고 계신가요',
    '무슨 일이 일어나고 있나요',
    'คุณกำลังคิดอะไรอยู่',
    'เขียนอะไรสักหน่อย',
    'Bạn viết gì đi',
    'Bạn đang nghĩ gì',
    'Tulis sesuatu',
    'Apa yang Anda pikirkan',
    'Apa yang anda fikirkan',
    // 菲律宾语小组 Discussion：现场「Magsulat...」
    'Magsulat',
    // 阿语小组 Discussion：现场「اكتب شيئًا...」
    'اكتب شيئًا',
  );

const createPostAriaPath = nodePath().css(
  'div[aria-label="Create a post"]',
  'div[aria-label="创建帖子"]',
  'div[aria-label="发帖"]',
  'div[aria-label="建立貼文"]',
  'div[aria-label="建立贴文"]',
  'div[aria-label="Criar publicação"]',
  'div[aria-label="Criar postagem"]',
  'div[aria-label="Criar uma publicação"]',
  'div[aria-label="Crear publicación"]',
  'div[aria-label="Créer une publication"]',
  'div[aria-label="Beitrag erstellen"]',
  'div[aria-label="Crea un post"]',
  'div[aria-label="Создать публикацию"]',
  'div[aria-label="投稿を作成"]',
  'div[aria-label="게시물 만들기"]',
  'div[aria-label="สร้างโพสต์"]',
  'div[aria-label="Tạo bài viết"]',
  'div[aria-label="Buat postingan"]',
  'div[aria-label="Buat siaran"]',
  // 马来语弹窗/入口：现场「Cipta siaran」
  'div[aria-label="Cipta siaran"]',
  // 菲律宾语弹窗/入口：现场「Gumawa ng post」
  'div[aria-label="Gumawa ng post"]',
  // 阿语弹窗/入口：现场「إنشاء منشور」
  'div[aria-label="إنشاء منشور"]',
);

const dialogTextboxPath = nodePath()
  .css('div[role="dialog"]')
  .then()
  .css('div[role="textbox"]')
  .one();

const dialogFileInputPath = nodePath()
  .css('div[role="dialog"]')
  .then()
  .css('input[type="file"]')
  .one();

const dialogVideoPath = nodePath()
  .css('div[role="dialog"]')
  .then()
  .css('video')
  .one();

/** 发布按钮：优先精确 aria-label（勿用短词 containAnyText，易误伤「匿名发帖」类文案）。 */
const dialogPostPath = nodePath()
  .css('div[role="dialog"]')
  .then()
  .css(
    'div[aria-label="Post"]',
    'div[aria-label="发布"]',
    'div[aria-label="發布"]',
    'div[aria-label="發佈"]',
    'div[aria-label="Publicar"]',
    'div[aria-label="Publier"]',
    'div[aria-label="Posten"]',
    'div[aria-label="Veröffentlichen"]',
    'div[aria-label="Pubblica"]',
    'div[aria-label="Опубликовать"]',
    'div[aria-label="投稿する"]',
    'div[aria-label="게시"]',
    'div[aria-label="올리기"]',
    'div[aria-label="โพสต์"]',
    'div[aria-label="Đăng"]',
    'div[aria-label="Posting"]',
    'div[aria-label="Kirim"]',
    'div[aria-label="Siarkan"]',
    // 马来语发帖弹窗：现场「Siaran」（非 Siarkan）
    'div[aria-label="Siaran"]',
    // 菲律宾语发帖弹窗：现场「I-post」
    'div[aria-label="I-post"]',
    // 阿语发帖弹窗：现场「نشر」
    'div[aria-label="نشر"]',
  )
  .one();

const anonymousSwitchOffPath = nodePath()
  .css('div[role="dialog"]')
  .then()
  .css('[role="switch"][aria-checked="false"]');

const anonymousSwitchOnPath = nodePath()
  .css('div[role="dialog"]')
  .then()
  .css('[role="switch"][aria-checked="true"]');

const anonymousGotItPath = nodePath().css(
  '[aria-label="Got it"]',
  '[aria-label="知道了"]',
  '[aria-label="瞭解"]',
  '[aria-label="了解"]',
  '[aria-label="Entendi"]',
  '[aria-label="Entendido"]',
  '[aria-label="J\'ai compris"]',
  '[aria-label="Verstanden"]',
  '[aria-label="Ho capito"]',
  '[aria-label="Понятно"]',
  '[aria-label="わかりました"]',
  '[aria-label="확인"]',
  '[aria-label="เข้าใจแล้ว"]',
  '[aria-label="Đã hiểu"]',
  '[aria-label="Mengerti"]',
  '[aria-label="Faham"]',
  'div[role="button"] ::-p-text(Got it,知道了,瞭解,了解,Entendi,Entendido,Đã hiểu,Mengerti,わかりました)',
);

/** 加入小组：多语 aria-label + 可见文案兜底。 */
const joinGroupPath = nodePath().css(
  'div[aria-label="Join group"]',
  'div[aria-label="Join Group"]',
  'div[aria-label="Join"]',
  'div[aria-label="Request to join"]',
  'div[aria-label="Join group and chat"]',
  'div[aria-label="加入小组"]',
  'div[aria-label="加入社團"]',
  // 繁中现场：加入群組（與「加入社團」不同）
  'div[aria-label="加入群組"]',
  'div[aria-label="加入"]',
  'div[aria-label="申請加入"]',
  'div[aria-label="申请加入"]',
  'div[aria-label="Participar do grupo"]',
  'div[aria-label="Participar"]',
  'div[aria-label="Solicitar participação"]',
  'div[aria-label="Unirse al grupo"]',
  'div[aria-label="Unirse"]',
  'div[aria-label="Rejoindre le groupe"]',
  'div[aria-label="Gruppe beitreten"]',
  'div[aria-label="Iscriviti al gruppo"]',
  'div[aria-label="Вступить в группу"]',
  'div[aria-label="グループに参加"]',
  'div[aria-label="그룹 가입"]',
  'div[aria-label="เข้าร่วมกลุ่ม"]',
  'div[aria-label="Tham gia nhóm"]',
  'div[aria-label="Tham gia"]',
  'div[aria-label="Gabung ke grup"]',
  'div[aria-label="Sertai kumpulan"]',
  // 菲律宾语：现场「Sumali sa group」
  'div[aria-label="Sumali sa group"]',
  'div[aria-label="Sumali"]',
  // 阿语：现场「انضمام إلى المجموعة」
  'div[aria-label="انضمام إلى المجموعة"]',
  'div[aria-label="انضمام"]',
);

const joinGroupTextPath = nodePath()
  .css('div[role="button"]')
  .containAnyText(
    'Join group',
    'Join Group',
    'Request to join',
    '加入小组',
    '加入社團',
    '加入群組',
    '申请加入',
    '申請加入',
    'Participar do grupo',
    'Unirse al grupo',
    'Rejoindre le groupe',
    'Gruppe beitreten',
    'Iscriviti',
    'Вступить',
    'グループに参加',
    '그룹 가입',
    'เข้าร่วมกลุ่ม',
    'Tham gia nhóm',
    'Gabung ke grup',
    'Sertai kumpulan',
    // 菲律宾语：现场「Sumali sa group」
    'Sumali sa group',
    'Sumali',
    // 阿语：现场「انضمام إلى المجموعة」
    'انضمام إلى المجموعة',
  );

const groupResultLinksPath = nodePath().css('a[href*="/groups/"]').many();

const pageScrollPath = nodePath().css('body');

/** Facebook「睡眠模式」等居中确认弹窗：点 OK，勿点右下角聊天 Refresh。 */
const blockingDialogOkPath = nodePath()
  .css('div[role="dialog"][aria-modal="true"]')
  .then()
  .css(
    'div[aria-label="OK"]',
    'div[aria-label="Ok"]',
    'div[aria-label="好的"]',
    'div[aria-label="确定"]',
    'div[aria-label="確定"]',
    'div[aria-label="好"]',
  )
  .one();

/** 账号风控：须手机确认身份 / 异常活动受限（仅含现场观察英文文案）。 */
const accountRestrictedPath = nodePath()
  .css('div[role="dialog"][aria-modal="true"]')
  .containAnyText(
    'confirm your identity',
    'unusual activity',
    'Certain actions have been restricted',
  );

/** 小组搜索空结果提示（多语）。 */
const emptyGroupResultsPath = nodePath()
  .css('div[role="main"]')
  .containAnyText(
    "We didn't find any results",
    'No results found',
    '未找到任何结果',
    '找不到任何結果',
    '没有找到结果',
    '沒有找到結果',
    'Nenhum resultado',
    'No se encontraron resultados',
    'Aucun résultat',
    'Keine Ergebnisse',
    'Nessun risultato',
    'Результаты не найдены',
    '結果が見つかりませんでした',
    '결과가 없습니다',
    'ไม่พบผลลัพธ์',
    'Không tìm thấy kết quả',
  );

function normalizeResources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

function takeImages(pool: string[], count: number): string[] {
  if (pool.length === 0 || count < 1) return [];
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    items.push(pool[i % pool.length]!);
  }
  return items;
}

function normalizeMediaType(raw: unknown): 'none' | 'image' | 'video' {
  const v = String(raw ?? 'none').trim().toLowerCase();
  if (v === 'image' || v === 'video') return v;
  return 'none';
}

function extractGroupId(href: string): string | null {
  const m = href.match(/\/groups\/(\d+)/i);
  return m?.[1] ?? null;
}

function toGroupUrl(id: string): string {
  return `${socialHome()}/groups/${id}`;
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: string,
  labels?: Record<string, string>,
  category?: 'selector_ui' | 'state_idempotent' | 'auth' | 'network' | 'business' | 'unknown',
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({
    step,
    reason,
    code,
    labels,
    category,
  });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
    category,
  });
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

/** 当前页是否已落到目标 URL（超时后兜底，避免 pageGoTo HTTP 超时但页面其实已打开）。 */
function urlMatchesTarget(pageUrl: string, targetUrl: string): boolean {
  try {
    const got = new URL(pageUrl);
    const want = new URL(targetUrl);
    if (!/(^|\.)facebook\.com$/i.test(got.hostname)) return false;
    if (got.pathname === want.pathname && got.search === want.search) return true;
    // 小组页可能追加 /? 或子路径
    if (want.pathname.startsWith('/groups/') && got.pathname.startsWith(want.pathname)) return true;
    return false;
  } catch {
    return pageUrl.includes(targetUrl) || targetUrl.includes(pageUrl);
  }
}

/**
 * 社媒导航：显式 domContentLoaded；失败/抛错后若 URL 已落地则视为成功；最多重试 1 次。
 * 禁止 wait=networkIdle（长连接站点易拖满 HTTP 超时）。
 */
async function gotoUrl(
  client: XportBrowserClient,
  url: string,
  timeoutMs = 45_000,
): Promise<[boolean, string]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [ok, msg] = await client.pageGoTo(0, {
        url,
        timeoutMs,
        wait: 'domContentLoaded',
      });
      if (ok) {
        await sleep(700);
        return [true, msg || ''];
      }
      client.taskLog(`pageGoTo attempt ${attempt + 1} failed: ${msg || 'unknown'}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      client.taskLog(`pageGoTo attempt ${attempt + 1} threw: ${reason}`);
    }

    const [urlOk, , pageUrl] = await client.getPageUrl();
    if (urlOk && pageUrl && urlMatchesTarget(pageUrl, url)) {
      client.taskLog(`pageGoTo recovered: already on ${pageUrl}`);
      await sleep(700);
      return [true, 'recovered after nav timeout'];
    }
    if (attempt === 0) await sleep(1200);
  }
  return [false, `pageGoTo failed for ${url}`];
}

async function waitForCount(
  client: XportBrowserClient,
  path: ReturnType<typeof nodePath>,
  pred: (n: number) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const [ok, , count] = await client.getNodeCount(0, path);
    last = ok && typeof count === 'number' ? count : 0;
    if (pred(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

/** 关闭睡眠模式等居中确认弹窗，避免挡住后续操作。 */
async function dismissBlockingDialogs(client: XportBrowserClient): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const [ok, , count] = await client.getNodeCount(0, blockingDialogOkPath);
    if (!ok || (count ?? 0) < 1) return;
    const [clickOk] = await client.clickNode(0, blockingDialogOkPath);
    if (!clickOk) return;
    client.taskLog('dismissed blocking dialog (e.g. sleep mode)');
    await sleep(600);
  }
}

async function collectGroupIds(client: XportBrowserClient): Promise<string[]> {
  const ids = new Set<string>();
  for (let round = 0; round < 4; round++) {
    const [ok, , table] = await client.getNodeData(0, groupResultLinksPath, ['attribute:href', 'text']);
    if (ok && table) {
      const hrefs = (table['attribute:href'] ?? table.href ?? []) as string[];
      for (const href of hrefs) {
        const id = extractGroupId(String(href || ''));
        if (id) ids.add(id);
      }
    }
    if (ids.size >= 8) break;
    await client.mouseWheel(0, pageScrollPath, { deltaY: 900 });
    await sleep(1100);
  }
  return [...ids];
}

async function clickOpenComposer(client: XportBrowserClient): Promise<boolean> {
  for (const path of [openComposerPath, createPostAriaPath]) {
    const [ok, , count] = await client.getNodeCount(0, path);
    if (ok && (count ?? 0) >= 1) {
      const [clickOk] = await client.clickNode(0, path);
      if (clickOk) return true;
    }
  }
  return false;
}

async function tryJoinGroup(client: XportBrowserClient, wantJoin: boolean): Promise<void> {
  if (!wantJoin) return;
  for (const path of [joinGroupPath, joinGroupTextPath]) {
    const [ok, , count] = await client.getNodeCount(0, path);
    if (!ok || (count ?? 0) < 1) continue;
    const [clickOk, clickMsg] = await client.clickNode(0, path);
    if (!clickOk) {
      client.taskLog(`join group click failed: ${clickMsg}`);
      return;
    }
    client.taskLog('clicked join group');
    await sleep(2000);
    return;
  }
  client.taskLog('join group control not found (already member or not available) — continue');
}

async function enableAnonymousIfWanted(
  client: XportBrowserClient,
  wantAnonymous: boolean,
): Promise<void> {
  if (!wantAnonymous) return;

  const [onOk, , onCount] = await client.getNodeCount(0, anonymousSwitchOnPath);
  if (onOk && (onCount ?? 0) >= 1) {
    client.taskLog('anonymous switch already on');
    return;
  }

  const [offOk, , offCount] = await client.getNodeCount(0, anonymousSwitchOffPath);
  if (!offOk || (offCount ?? 0) < 1) {
    client.taskLog('anonymous switch not found; group may not support anonymous posts — skip');
    return;
  }

  const [clickOk, clickMsg] = await client.clickNode(0, anonymousSwitchOffPath);
  if (!clickOk) {
    client.taskLog(`click anonymous switch failed: ${clickMsg}`);
    return;
  }
  await sleep(600);

  const gotItReady = await waitForCount(client, anonymousGotItPath, (n) => n >= 1, 5_000);
  if (gotItReady >= 1) {
    const [gotOk, gotMsg] = await client.clickNode(0, anonymousGotItPath);
    if (!gotOk) {
      client.taskLog(`click Got it failed: ${gotMsg}`);
    } else {
      await sleep(800);
    }
  }

  const enabled = await waitForCount(client, anonymousSwitchOnPath, (n) => n >= 1, 8_000);
  client.taskLog(enabled >= 1 ? 'anonymous switch enabled' : 'anonymous switch state unclear after toggle');
}

async function detectAccountRestricted(client: XportBrowserClient): Promise<boolean> {
  const [ok, , count] = await client.getNodeCount(0, accountRestrictedPath);
  return Boolean(ok && (count ?? 0) >= 1);
}

async function markAccountRestricted(client: XportBrowserClient): Promise<void> {
  const [ok, msg] = await client.addDeviceLabels([RESTRICTED_ACCOUNT_LABEL]);
  client.taskLog(
    ok
      ? `device labeled: ${RESTRICTED_ACCOUNT_LABEL}`
      : `failed to label restricted account: ${msg || 'unknown'}`,
  );
}

/** 主关键词优先，再接任务组关键词池（去重），用于无结果时自动切换。 */
function resolveKeywordQueue(taskConfig: TaskRunConfig): string[] {
  const primary = String(taskConfig.keyword ?? '').trim();
  const pool = splitConfigLines(taskConfig.keywords);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [primary, ...pool]) {
    const k = String(raw ?? '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

async function publishInOpenComposer(
  client: XportBrowserClient,
  content: string,
  mediaType: 'none' | 'image' | 'video',
  images: string[],
  video: string,
  wantAnonymous: boolean,
  labels: Record<string, string>,
): Promise<
  | { ok: true }
  | { ok: false; step: string; reason: string; code: string; category?: 'auth' | 'selector_ui' | 'unknown' }
> {
  // 骨架屏较慢时偶发 >15s；同时轮询账号受限弹窗，避免误判为控件缺失
  const textboxDeadline = Date.now() + 28_000;
  let textboxCount = 0;
  while (Date.now() < textboxDeadline) {
    if (await detectAccountRestricted(client)) {
      return {
        ok: false,
        step: 'account_restricted',
        reason:
          'Facebook restricted posting on this account (identity confirmation / unusual activity). Open Facebook on the linked mobile device to confirm identity, or use another logged-in profile.',
        code: 'ACCOUNT_RESTRICTED',
        category: 'auth',
      };
    }
    const [ok, , count] = await client.getNodeCount(0, dialogTextboxPath);
    textboxCount = ok && typeof count === 'number' ? count : 0;
    if (textboxCount >= 1) break;
    await sleep(500);
  }
  if (textboxCount < 1) {
    if (await detectAccountRestricted(client)) {
      return {
        ok: false,
        step: 'account_restricted',
        reason:
          'Facebook restricted posting on this account (identity confirmation / unusual activity). Open Facebook on the linked mobile device to confirm identity, or use another logged-in profile.',
        code: 'ACCOUNT_RESTRICTED',
        category: 'auth',
      };
    }
    return {
      ok: false,
      step: 'wait_composer_dialog',
      reason: 'Post composer dialog did not open',
      code: 'ELEMENT_NOT_FOUND',
    };
  }

  await enableAnonymousIfWanted(client, wantAnonymous);

  const [typeOk, typeMsg] = await client.typeInNode(0, dialogTextboxPath, content);
  if (!typeOk) {
    return { ok: false, step: 'fill_content', reason: typeMsg || 'failed to type post content', code: 'ELEMENT_NOT_FOUND' };
  }

  if (mediaType === 'image' || mediaType === 'video') {
    const fileCount = await waitForCount(client, dialogFileInputPath, (n) => n >= 1, 10_000);
    if (fileCount < 1) {
      return { ok: false, step: 'find_file_input', reason: 'File input not found in post dialog', code: 'ELEMENT_NOT_FOUND' };
    }

    if (mediaType === 'video') {
      const [upOk, upMsg] = await client.uploadFile(0, dialogFileInputPath, video);
      if (!upOk) {
        return { ok: false, step: 'upload_video', reason: upMsg || 'uploadFile failed', code: 'UNKNOWN' };
      }
      const videoReady = await waitForCount(client, dialogVideoPath, (n) => n >= 1, 90_000, 800);
      if (videoReady < 1) {
        return {
          ok: false,
          step: 'wait_video_preview',
          reason: 'Video preview did not appear in the composer dialog',
          code: 'ELEMENT_NOT_FOUND',
        };
      }
      await sleep(2500);
    } else if (images.length === 1) {
      const [upOk, upMsg] = await client.uploadFile(0, dialogFileInputPath, images[0]!);
      if (!upOk) {
        return { ok: false, step: 'upload_images', reason: upMsg || 'uploadFile failed', code: 'UNKNOWN' };
      }
      await sleep(2500);
    } else {
      const [upOk, upMsg] = await client.uploadFiles(0, dialogFileInputPath, images);
      if (!upOk) {
        return { ok: false, step: 'upload_images', reason: upMsg || 'uploadFiles failed', code: 'UNKNOWN' };
      }
      await sleep(2500);
    }
  }

  const postBtnCount = await waitForCount(client, dialogPostPath, (n) => n >= 1, 15_000);
  if (postBtnCount < 1) {
    return { ok: false, step: 'find_post_button', reason: 'Post button not found in dialog', code: 'ELEMENT_NOT_FOUND' };
  }

  const publishTimeoutMs = mediaType === 'video' ? 180_000 : 90_000;
  const publishDeadline = Date.now() + publishTimeoutMs;
  while (Date.now() < publishDeadline) {
    const [postOk, postMsg] = await client.clickNode(0, dialogPostPath);
    if (!postOk) {
      client.taskLog(`click Post: ${postMsg}`);
    }
    await sleep(mediaType === 'video' ? 2500 : 1500);
    const [, , remaining] = await client.getNodeCount(0, dialogTextboxPath);
    if ((remaining ?? 0) === 0) {
      return { ok: true };
    }
    await sleep(1200);
  }

  return {
    ok: false,
    step: 'publish_post',
    reason: 'Post dialog did not close after clicking Post. Publishing may still be in progress or blocked.',
    code: 'UNKNOWN',
  };
}

/**
 * 在单个小组尝试发帖；无法发帖则返回 skipped，不视为任务失败。
 */
async function tryPostInGroup(
  client: XportBrowserClient,
  groupUrl: string,
  content: string,
  mediaType: 'none' | 'image' | 'video',
  images: string[],
  video: string,
  wantAnonymous: boolean,
  wantJoin: boolean,
  labels: Record<string, string>,
): Promise<'success' | 'skipped' | 'restricted' | { fail: AutomationRunResult }> {
  const [goOk, goMsg] = await gotoUrl(client, groupUrl);
  if (!goOk) {
    client.taskLog(`open group failed (${goMsg}); skip ${groupUrl}`);
    return 'skipped';
  }
  // 社媒勿用 networkIdle；等加入/发帖入口任一出现（骨架屏可能晚于 readyState）
  await sleep(800);
  {
    const readyDeadline = Date.now() + 15_000;
    while (Date.now() < readyDeadline) {
      if (await detectAccountRestricted(client)) {
        return 'restricted';
      }
      const [cOk, , cCount] = await client.getNodeCount(0, openComposerPath);
      const [aOk, , aCount] = await client.getNodeCount(0, createPostAriaPath);
      const [jOk, , jCount] = await client.getNodeCount(0, joinGroupPath);
      if (
        (cOk && (cCount ?? 0) >= 1) ||
        (aOk && (aCount ?? 0) >= 1) ||
        (jOk && (jCount ?? 0) >= 1)
      ) {
        break;
      }
      await sleep(500);
    }
  }

  const [urlOk, , pageUrl] = await client.getPageUrl();
  if (urlOk && /\/login/i.test(pageUrl ?? '')) {
    return {
      fail: await failStep(
        client,
        'check_login',
        'Browser is not logged in to Facebook. Please log in on this fingerprint profile first.',
        'NOT_LOGGED_IN',
        labels,
      ),
    };
  }

  if (await detectAccountRestricted(client)) {
    return 'restricted';
  }

  await dismissBlockingDialogs(client);
  await tryJoinGroup(client, wantJoin);

  const composerReady = await waitForCount(client, openComposerPath, (n) => n >= 1, 12_000);
  const ariaReady =
    composerReady >= 1 ? 1 : await waitForCount(client, createPostAriaPath, (n) => n >= 1, 6_000);
  if (composerReady < 1 && ariaReady < 1) {
    client.taskLog(`no compose entry in ${groupUrl} — skip (not public / no post permission)`);
    return 'skipped';
  }

  const opened = await clickOpenComposer(client);
  if (!opened) {
    client.taskLog(`failed to open composer in ${groupUrl} — skip`);
    return 'skipped';
  }
  await sleep(600);

  const published = await publishInOpenComposer(
    client,
    content,
    mediaType,
    images,
    video,
    wantAnonymous,
    labels,
  );
  if (!published.ok) {
    if (published.code === 'ACCOUNT_RESTRICTED') {
      return 'restricted';
    }
    // 发帖中途控件失败：关弹窗后跳过该组，继续下一组
    client.taskLog(`post failed in group (${published.step}: ${published.reason}) — skip`);
    await client.pressKey(0, 'Escape');
    await sleep(500);
    return 'skipped';
  }
  return 'success';
}

async function finishAccountRestricted(
  client: XportBrowserClient,
  labels: Record<string, string>,
  data: Record<string, unknown>,
): Promise<AutomationRunResult> {
  await markAccountRestricted(client);
  await client.captureIncident({
    step: 'account_restricted',
    reason:
      'Facebook restricted this account (identity confirmation / unusual activity). Skipped and labeled.',
    code: 'ACCOUNT_RESTRICTED',
    category: 'auth',
    labels: { ...labels, accountRestricted: '1' },
  });
  client.taskLog(`account restricted — skip task and label ${RESTRICTED_ACCOUNT_LABEL}`);
  return {
    succ: true,
    msg: `账号受限已跳过，并已标记「${RESTRICTED_ACCOUNT_LABEL}」`,
    data: {
      ...data,
      accountRestricted: 1,
    },
  };
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  const keywordQueue = resolveKeywordQueue(taskConfig);
  const content = String(taskConfig.content ?? '').trim();
  const targetCount = parsePositiveIntConfig(taskConfig.group_count ?? 1, 1);
  const wantAnonymous = Number(taskConfig.post_anonymously) === 1;
  const wantJoin = Number(taskConfig.join_group) === 1;
  const mediaType = normalizeMediaType(taskConfig.media_type);
  const imagePool = normalizeResources(taskConfig.images);
  const imageCount = parsePositiveIntConfig(taskConfig.image_count ?? 1, 1);
  const images = mediaType === 'image' ? takeImages(imagePool, imageCount) : [];
  const video =
    typeof taskConfig.video === 'string' && taskConfig.video.trim()
      ? taskConfig.video.trim()
      : '';
  const mediaCount = mediaType === 'video' ? (video ? 1 : 0) : mediaType === 'image' ? images.length : 0;

  let activeKeyword = keywordQueue[0] ?? '';
  const labels = {
    keyword: activeKeyword,
    targetCount: String(targetCount),
    mediaType,
    contentPreview: content.slice(0, 80),
    mediaCount: String(mediaCount),
    postAnonymously: wantAnonymous ? '1' : '0',
    joinGroup: wantJoin ? '1' : '0',
    keywordPoolSize: String(keywordQueue.length),
  };

  client.taskLog(
    `keywords=${keywordQueue.length ? keywordQueue.join(' | ') : '(empty)'} target=${targetCount} mediaType=${mediaType} anonymous=${wantAnonymous ? 1 : 0} join=${wantJoin ? 1 : 0} contentLen=${content.length}`,
  );

  if (keywordQueue.length === 0) {
    return automationFailWithContext('keyword / keywords is required in taskRunConfig', {
      code: 'UNKNOWN',
      step: 'validate_keyword',
    });
  }
  if (!content) {
    return automationFailWithContext('content is required in taskRunConfig', {
      code: 'UNKNOWN',
      step: 'validate_content',
    });
  }
  if (targetCount < 1) {
    return automationFailWithContext('group_count must be at least 1', {
      code: 'UNKNOWN',
      step: 'validate_group_count',
    });
  }
  if (mediaType === 'image') {
    if (imagePool.length === 0) {
      return automationFailWithContext('images is required when media_type=image', {
        code: 'UNKNOWN',
        step: 'validate_images',
      });
    }
  }
  if (mediaType === 'video' && !video) {
    return automationFailWithContext('video is required when media_type=video (one per post)', {
      code: 'UNKNOWN',
      step: 'validate_video',
    });
  }

  let successCount = 0;
  let skippedCount = 0;
  let finalUrl = '';
  let lastSearchUrl = '';
  const emptyKeywords: string[] = [];
  const triedGroupIds = new Set<string>();

  try {
    for (let ki = 0; ki < keywordQueue.length && successCount < targetCount; ki++) {
      activeKeyword = keywordQueue[ki]!;
      labels.keyword = activeKeyword;
      const searchUrl = `${socialHome()}/search/groups?q=${encodeURIComponent(activeKeyword)}`;
      lastSearchUrl = searchUrl;
      client.taskLog(`search keyword ${ki + 1}/${keywordQueue.length}: ${activeKeyword}`);

      const [goOk, goMsg] = await gotoUrl(client, searchUrl);
      if (!goOk) {
        return await failStep(client, 'open_search', goMsg || 'pageGoTo search failed', 'NAV_FAILED', labels);
      }
      await sleep(1000);
      await dismissBlockingDialogs(client);

      if (await detectAccountRestricted(client)) {
        return await finishAccountRestricted(client, labels, {
          keyword: activeKeyword,
          targetCount,
          successCount,
          skippedCount,
          finalUrl: finalUrl || lastSearchUrl,
          accountRestricted: 1,
        });
      }

      const [urlOk, , pageUrl] = await client.getPageUrl();
      if (urlOk && /\/login/i.test(pageUrl ?? '')) {
        return await failStep(
          client,
          'check_login',
          'Browser is not logged in to Facebook. Please log in on this fingerprint profile first.',
          'NOT_LOGGED_IN',
          labels,
        );
      }

      const groupIds = shuffleInPlace(await collectGroupIds(client)).filter((id) => !triedGroupIds.has(id));
      client.taskLog(`found ${groupIds.length} new group candidates for keyword=${activeKeyword}`);
      if (groupIds.length === 0) {
        emptyKeywords.push(activeKeyword);
        client.taskLog(`no groups for keyword="${activeKeyword}" — try next keyword`);
        continue;
      }

      let cursor = 0;
      let refreshRounds = 0;
      while (successCount < targetCount) {
        if (cursor >= groupIds.length) {
          if (refreshRounds >= 2) break;
          refreshRounds += 1;
          await gotoUrl(client, searchUrl);
          await sleep(1000);
          await dismissBlockingDialogs(client);
          if (await detectAccountRestricted(client)) {
            return await finishAccountRestricted(client, labels, {
              keyword: activeKeyword,
              targetCount,
              successCount,
              skippedCount,
              finalUrl: finalUrl || lastSearchUrl,
              accountRestricted: 1,
            });
          }
          for (let i = 0; i < refreshRounds + 1; i++) {
            await client.mouseWheel(0, pageScrollPath, { deltaY: 1200 });
            await sleep(700);
          }
          const more = await collectGroupIds(client);
          const fresh: string[] = [];
          for (const id of more) {
            if (!triedGroupIds.has(id) && !groupIds.includes(id)) {
              groupIds.push(id);
              fresh.push(id);
            }
          }
          if (fresh.length > 0) {
            const tail = groupIds.splice(cursor);
            shuffleInPlace(tail);
            groupIds.push(...tail);
          }
          if (cursor >= groupIds.length) break;
        }

        const id = groupIds[cursor++]!;
        triedGroupIds.add(id);
        const groupUrl = toGroupUrl(id);
        client.taskLog(`try group ${successCount + 1}/${targetCount}: ${groupUrl} (kw=${activeKeyword})`);

        const result = await tryPostInGroup(
          client,
          groupUrl,
          content,
          mediaType,
          images,
          video,
          wantAnonymous,
          wantJoin,
          { ...labels, groupUrl },
        );

        if (typeof result === 'object' && 'fail' in result) {
          return result.fail;
        }
        if (result === 'restricted') {
          return await finishAccountRestricted(client, labels, {
            keyword: activeKeyword,
            targetCount,
            successCount,
            skippedCount,
            finalUrl: finalUrl || groupUrl,
            accountRestricted: 1,
          });
        }
        if (result === 'success') {
          successCount += 1;
          finalUrl = groupUrl;
          client.taskLog(`posted ok (${successCount}/${targetCount}) in ${groupUrl}`);
        } else {
          skippedCount += 1;
        }
      }

      if (successCount < targetCount) {
        client.taskLog(
          `keyword="${activeKeyword}" exhausted (success=${successCount}/${targetCount}) — switch keyword if any`,
        );
      }
    }

    if (successCount < 1) {
      if (emptyKeywords.length >= keywordQueue.length) {
        return await failStep(
          client,
          'collect_groups',
          `No groups found for any keyword (${keywordQueue.join(' / ')}). Please add keywords that return group results.`,
          'NO_RESULTS',
          { ...labels, skippedCount: String(skippedCount), emptyKeywords: emptyKeywords.join(',') },
          'business',
        );
      }
      return await failStep(
        client,
        'post_groups',
        `Could not publish in any group (skipped=${skippedCount}). Check join permission / public posting / UI language.`,
        'ELEMENT_NOT_FOUND',
        { ...labels, skippedCount: String(skippedCount) },
      );
    }

    if (successCount < targetCount) {
      client.taskLog(
        `partial success: posted ${successCount}/${targetCount}, skipped=${skippedCount}, emptyKeywords=${emptyKeywords.length}`,
      );
    }

    const [, , lastUrl] = await client.getPageUrl();
    return {
      succ: true,
      msg: `posted in ${successCount} group(s), skipped ${skippedCount}`,
      data: {
        keyword: activeKeyword,
        targetCount,
        successCount,
        skippedCount,
        finalUrl: finalUrl || lastUrl || lastSearchUrl,
        accountRestricted: 0,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await failStep(client, 'unexpected', reason, 'UNKNOWN', {
      ...labels,
      successCount: String(successCount),
      skippedCount: String(skippedCount),
    });
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(
  await XportBrowserClient.run((client) => runAutomation(client, taskConfig)),
);
