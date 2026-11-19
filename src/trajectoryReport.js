/** A self-contained, offline report for one run. No script or remote assets. */

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const safeImage = (step) => {
  const format = step.imageFormat === 'jpeg' ? 'jpeg' : 'png';
  const base64 = String(step.imageBase64 || '');
  return /^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    ? `data:image/${format};base64,${base64}` : '';
};

/** Read PNG IHDR without decoding the whole screenshot into another large buffer. */
export function pngDimensions(base64) {
  try {
    const head = atob(String(base64).slice(0, 32));
    if (head.length < 24 || head.slice(1, 4) !== 'PNG' || head.slice(12, 16) !== 'IHDR') return null;
    const uint = (offset) => Array.from({ length: 4 }, (_, i) => head.charCodeAt(offset + i))
      .reduce((value, byte) => value * 256 + byte, 0);
    const width = uint(16);
    const height = uint(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch (_) {
    return null;
  }
}

const pointLabel = (point) => point
  ? `모델 (${escapeHtml(point.modelX)}, ${escapeHtml(point.modelY)}) → 화면 (${point.x}, ${point.y})`
  : '화면 좌표 없음';

function marker(point, viewport, label) {
  if (!point || !viewport?.width || !viewport?.height) return '';
  const x = Math.max(0, Math.min(100, point.x / viewport.width * 100));
  const y = Math.max(0, Math.min(100, point.y / viewport.height * 100));
  return `<span class="marker" style="left:${x.toFixed(3)}%;top:${y.toFixed(3)}%" title="${escapeHtml(label)}"></span>`;
}

function stepHtml(step) {
  const size = `${step.viewport?.width ?? '?'}×${step.viewport?.height ?? '?'} CSS px` +
    (step.imagePixels ? ` · 이미지 ${step.imagePixels.width}×${step.imagePixels.height} px` : '');
  const screenshot = safeImage(step);
  const image = screenshot
    ? `<div class="image"><img src="${screenshot}" alt="${escapeHtml(step.step)}단계 실행 전 화면">${marker(step.point, step.viewport, pointLabel(step.point))}${marker(step.endPoint, step.viewport, '드래그 끝점')}</div>`
    : '<p class="missing">스크린샷을 저장하지 못했습니다.</p>';
  const actionJson = JSON.stringify(step.action || {}, null, 2);
  return `<article class="step">
  <header><h2>Step ${escapeHtml(step.step)} · ${escapeHtml(step.action?.action || '응답 없음')}</h2><span>${escapeHtml(size)}</span></header>
  <p class="meta">${escapeHtml(step.pageUrl || '')}${step.pageTitle ? ` · ${escapeHtml(step.pageTitle)}` : ''}</p>
  ${image}
  <dl><dt>모델 좌표 → 실제 좌표</dt><dd>${pointLabel(step.point)}${step.endPoint ? ` / 끝점 ${pointLabel(step.endPoint)}` : ''}</dd>
  <dt>think</dt><dd class="pre">${escapeHtml(step.think || '')}</dd>
  <dt>실행 결과</dt><dd class="pre">${escapeHtml(step.detail || step.result || '')}</dd></dl>
  <details><summary>도구 인자와 원본 응답</summary><pre>${escapeHtml(actionJson)}</pre><pre>${escapeHtml(step.reply || '')}</pre></details>
</article>`;
}

export function renderTrajectoryHtml(run, logs = []) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const sizes = [...new Set(steps.map((s) => `${s.viewport?.width ?? '?'}×${s.viewport?.height ?? '?'}`))];
  const logHtml = logs.map((entry) => `<div class="log log--${/^[a-z]+$/.test(entry.kind) ? entry.kind : 'info'}"><time>${escapeHtml(entry.time)}</time><span>${escapeHtml(entry.text)}</span></div>`).join('\n');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(run?.task || 'GUI 실행 기록')} · GUI trajectory</title>
<style>
:root{color-scheme:light;font:14px/1.55 system-ui,sans-serif;color:#1b2430;background:#f4f6fa}
*{box-sizing:border-box}body{margin:0 auto;padding:24px;max-width:1300px}h1{font-size:24px;margin:0 0 8px}h2{font-size:17px;margin:0}p{overflow-wrap:anywhere}
.intro,.step,.logs{background:white;border:1px solid #d9e0ea;border-radius:10px;padding:18px;margin:0 0 18px;box-shadow:0 1px 3px #12203312}
.intro dl{display:grid;grid-template-columns:130px 1fr;gap:6px 12px}.intro dt,dt{font-weight:700;color:#4a5c70}.intro dd,dd{margin:0;overflow-wrap:anywhere}
.step header{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.meta{color:#586a7c;margin:4px 0 12px}.image{position:relative;display:inline-block;max-width:100%;line-height:0;border:1px solid #b7c4d4;background:#edf1f5}.image img{display:block;max-width:100%;height:auto}.marker{position:absolute;width:22px;height:22px;border:3px solid #ff263b;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 2px white,0 1px 5px #0008;pointer-events:none}.marker:after{content:'';position:absolute;left:7px;top:7px;width:2px;height:2px;background:#ff263b}
.step dl{display:grid;grid-template-columns:155px 1fr;gap:8px 12px;margin:14px 0}.pre,pre{white-space:pre-wrap;overflow-wrap:anywhere}pre{background:#f1f4f8;padding:12px;border-radius:6px;max-height:300px;overflow:auto}details{border-top:1px solid #e1e6ee;padding-top:10px}summary{cursor:pointer;font-weight:600}.logs h2{margin-bottom:8px}.log{display:flex;gap:12px;border-top:1px solid #eef1f5;padding:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}.log time{color:#738296;flex:none}.log--warn{color:#966200}.log--error{color:#ad2634}.missing{color:#ad2634}
</style></head><body>
<section class="intro"><h1>GUI trajectory</h1><dl>
<dt>작업</dt><dd>${escapeHtml(run?.task || '')}</dd>
<dt>시작 URL</dt><dd>${escapeHtml(run?.startUrl || '')}</dd>
<dt>모델</dt><dd>${escapeHtml(run?.model || '')}</dd>
<dt>좌표 방식</dt><dd>${escapeHtml(run?.coordMode || '')}</dd>
<dt>실행 시각</dt><dd>${escapeHtml(run?.startedAt || '')} → ${escapeHtml(run?.endedAt || '진행 중')}</dd>
<dt>기록</dt><dd>${steps.length}단계 · 관측 화면 ${escapeHtml(sizes.join(', ') || '없음')}</dd>
<dt>이미지</dt><dd>캡처 ${escapeHtml(run?.captures ?? steps.length)}장 · 모델 입력 이미지 ${escapeHtml(run?.imagesSent ?? steps.length)}장 · HTML에 저장한 화면 ${steps.length}장</dd>
<dt>학습 화면</dt><dd>한국어·영어 1280×720 · 영어 1280×1000. 브라우저 화면은 자동 조정되지 않습니다.</dd>
</dl></section>
${steps.map(stepHtml).join('\n')}
<section class="logs"><h2>실행 로그</h2>${logHtml}</section>
</body></html>`;
}

export function trajectoryFilename(task, startedAt = new Date().toISOString()) {
  const stamp = String(startedAt).replace(/[:.]/g, '-').replace(/[^0-9TZ-]/g, '').slice(0, 19);
  const slug = String(task || 'task').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'task';
  return `trajectory_${stamp}_${slug}.html`;
}
