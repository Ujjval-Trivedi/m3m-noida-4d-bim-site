
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pw, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(salt), iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

export async function openSealed(key, buf) {
  const u8 = new Uint8Array(buf);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12) }, key, u8.subarray(12)));
  return gunzip(plain);
}

async function gunzip(u8) {
  if (window.DecompressionStream) {
    try {
      return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    } catch {  }
  }
  let p = 10; const f = u8[3];
  if (f & 4) p += 2 + (u8[p] | (u8[p + 1] << 8));
  if (f & 8) while (u8[p++]);
  if (f & 16) while (u8[p++]);
  if (f & 2) p += 2;
  return inflate(u8, p);
}

function inflate(src, pos) {
  let bit = 0, nb = 0, out = new Uint8Array(src.length * 4), op = 0;
  const room = (n) => { if (op + n > out.length) { const o = new Uint8Array(Math.max(out.length * 2, op + n)); o.set(out); out = o; } };
  const bits = (n) => { while (nb < n) { bit |= src[pos++] << nb; nb += 8; } const v = bit & ((1 << n) - 1); bit >>>= n; nb -= n; return v; };
  const tree = (lens) => {
    const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(lens.length);
    for (const l of lens) count[l]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    lens.forEach((l, i) => { if (l) sym[offs[l]++] = i; });
    return { count, sym };
  };
  const decode = (t) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1); const c = t.count[len];
      if (code - c < first) return t.sym[index + code - first];
      index += c; first = (first + c) << 1; code <<= 1;
    }
    throw new Error('bad data');
  };
  const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LX = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DX = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  let last;
  do {
    last = bits(1); const type = bits(2);
    if (type === 0) {
      bit = 0; nb = 0; const n = src[pos] | (src[pos + 1] << 8); pos += 4;
      room(n); out.set(src.subarray(pos, pos + n), op); op += n; pos += n; continue;
    }
    let lt, dt;
    if (type === 1) {
      lt = tree(new Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288));
      dt = tree(new Array(30).fill(5));
    } else {
      const hl = bits(5) + 257, hd = bits(5) + 1, hc = bits(4) + 4, cl = new Array(19).fill(0);
      const ORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      for (let i = 0; i < hc; i++) cl[ORD[i]] = bits(3);
      const ct = tree(cl), lens = [];
      while (lens.length < hl + hd) {
        const sy = decode(ct);
        if (sy < 16) lens.push(sy);
        else if (sy === 16) { const pv = lens[lens.length - 1]; for (let r = 3 + bits(2); r--;) lens.push(pv); }
        else for (let r = sy === 17 ? 3 + bits(3) : 11 + bits(7); r--;) lens.push(0);
      }
      lt = tree(lens.slice(0, hl)); dt = tree(lens.slice(hl));
    }
    for (;;) {
      const sy = decode(lt);
      if (sy < 256) { room(1); out[op++] = sy; continue; }
      if (sy === 256) break;
      const n = LB[sy - 257] + bits(LX[sy - 257]), ds = decode(dt), d = DB[ds] + bits(DX[ds]);
      room(n); for (let k = 0; k < n; k++, op++) out[op] = out[op - d];
    }
  } while (!last);
  return out.subarray(0, op);
}

const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10.4 10.4 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('viewer-keys', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('k');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = (mode, fn) => idb().then((db) => new Promise((res, rej) => {
  const q = fn(db.transaction('k', mode).objectStore('k')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
}));

export async function unlockSite(cfg, ui) {
  if (!window.crypto?.subtle) throw new Error('This browser cannot open protected pages. Use a current Safari, Chrome or Edge.');
  const KID = `${location.pathname}|${cfg.salt}`;
  const checkBuf = b64(cfg.check);
  const works = async (key) => { try { await openSealed(key, checkBuf); return true; } catch { return false; } };

  const saved = await tx('readonly', (s) => s.get(KID)).catch(() => null);
  if (saved && await works(saved)) return saved;
  if (saved) await tx('readwrite', (s) => s.delete(KID)).catch(() => null);

  return new Promise((resolve) => {
    const form = document.createElement('form');
    form.className = 'lock';
    form.autocomplete = 'on';
    form.innerHTML = `
      ${ui.logos?.length ? '<div class="lock-logos"></div>' : ''}
      ${ui.eyebrow ? `<div class="lock-eyebrow"></div>` : ''}
      <h1 class="lock-title"></h1>
      <label for="lockPw">Password</label>
      <div class="lock-field">
        <input type="password" id="lockPw" name="password" autocomplete="current-password" required>
        <button type="button" class="lock-eye" aria-label="Show password" title="Show password" aria-pressed="false">${EYE}</button>
      </div>
      <label class="lock-rem"><input type="checkbox" id="lockRem"> Remember on this device</label>
      <button type="submit" id="lockGo">Open dashboard</button>
      <div class="lock-msg" role="alert"></div>
      <div class="lock-note"></div>`;
    if (ui.logos?.length) {
      const box = form.querySelector('.lock-logos');
      ui.logos.forEach((l, i) => {
        if (i) box.append(Object.assign(document.createElement('span'), { className: 'lock-sep' }));
        const img = Object.assign(document.createElement('img'), { src: l.src, alt: l.alt ?? '' });
        if (l.height) img.style.height = `${l.height}px`;
        box.append(img);
      });
    }
    if (ui.eyebrow) form.querySelector('.lock-eyebrow').textContent = ui.eyebrow;
    form.querySelector('.lock-title').textContent = ui.title || 'Protected';
    form.querySelector('.lock-note').textContent = ui.note || 'Protected. Ask your VisiLean contact for the password.';
    ui.mount.replaceChildren(form);
    const pw = form.querySelector('#lockPw'), go = form.querySelector('#lockGo'), msg = form.querySelector('.lock-msg');
    const eye = form.querySelector('.lock-eye');
    eye.onclick = () => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      eye.title = eye.getAttribute('aria-label');
      eye.innerHTML = show ? EYE_OFF : EYE;
      pw.focus();
    };
    pw.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true; go.textContent = 'Opening…'; msg.textContent = '';
      const key = await derive(pw.value, cfg.salt, cfg.iter);
      if (!(await works(key))) {
        msg.textContent = 'That password is not right. Please try again.';
        go.disabled = false; go.textContent = 'Open dashboard'; pw.select();
        return;
      }
      if (form.querySelector('#lockRem').checked) await tx('readwrite', (s) => s.put(key, KID)).catch(() => null);
      else await tx('readwrite', (s) => s.delete(KID)).catch(() => null);
      resolve(key);
    });
  });
}
