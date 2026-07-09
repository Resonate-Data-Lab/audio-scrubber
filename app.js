'use strict';

const DURATION    = 10;     // fixed audio window, seconds
const FFT_SIZE    = 2048;
const HOP_SIZE    = 512;
const F_MIN       = 40;     // Hz, spectrogram bottom
const DB_FLOOR    = -80;    // dB floor for spectrogram colormap

// Grain parameters — tuned for smoothness over precision
const G_DURATION  = 0.20;
const G_OVERLAP   = 4;
const G_INTERVAL  = G_DURATION / G_OVERLAP;   // 50ms between triggers
const G_FADE      = 0.04;
const G_LOOKAHEAD = 0.10;
const G_JITTER    = 0.015;

const RING_STEPS  = 2000;   // angular resolution for ring drawing

// ── Granular Scrubber ──────────────────────────────────────────────────────

class GranularScrubber {
  constructor(audioCtx, buffer) {
    this.ac     = audioCtx;
    this.buffer = buffer;
    this.pos    = 0;
    this.active = false;
    this.timer  = null;

    this.master = audioCtx.createGain();
    this.master.gain.value = 0;
    this.master.connect(audioCtx.destination);
  }

  setPosition(secs) {
    this.pos = Math.max(0, Math.min(DURATION, secs));
  }

  _scheduleGrain() {
    const { ac, buffer, pos } = this;
    const startTime = ac.currentTime + G_LOOKAHEAD;
    const jitter    = (Math.random() * 2 - 1) * G_JITTER;
    const offset    = Math.max(0, Math.min(buffer.duration - G_DURATION, pos + jitter));

    const src  = ac.createBufferSource();
    src.buffer = buffer;
    const env  = ac.createGain();
    src.connect(env);
    env.connect(this.master);

    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(1, startTime + G_FADE);
    env.gain.setValueAtTime(1, startTime + G_DURATION - G_FADE);
    env.gain.linearRampToValueAtTime(0, startTime + G_DURATION);

    src.start(startTime, offset, G_DURATION);
    src.onended = () => { src.disconnect(); env.disconnect(); };
  }

  start() {
    if (this.active) return;
    this.active = true;
    const now = this.ac.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(1 / G_OVERLAP, now + 0.05);
    this._scheduleGrain();
    this.timer = setInterval(() => { if (this.active) this._scheduleGrain(); }, G_INTERVAL * 1000);
  }

  stop() {
    this.active = false;
    clearInterval(this.timer);
    this.timer = null;
    const now = this.ac.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 0.12);
  }
}

// ── Main App ───────────────────────────────────────────────────────────────

class AudioScrubber {
  constructor() {
    this.waveformEl  = document.getElementById('waveform');
    this.spectroEl   = document.getElementById('spectrogram');
    this.ringEl      = document.getElementById('ring');
    this.recordBtn   = document.getElementById('record-btn');
    this.fileInput   = document.getElementById('file-input');
    this.playBtn     = document.getElementById('play-btn');
    this.stopBtn     = document.getElementById('stop-btn');
    this.timeDisplay = document.getElementById('time-display');
    this.statusEl    = document.getElementById('status');

    this.wCtx = this.waveformEl.getContext('2d');
    this.sCtx = this.spectroEl.getContext('2d');
    this.rCtx = this.ringEl.getContext('2d');

    this.audioCtx   = null;
    this.buffer     = null;
    this.mono       = null;
    this.waveImg    = null;
    this.spectroImg = null;
    this.ringImg    = null;

    this.source    = null;
    this.isPlaying = false;
    this.acStarted = 0;
    this.posOffset = 0;
    this.rafId     = null;

    this.granular    = null;
    this.recorder    = null;
    this.recChunks   = [];
    this.isRecording = false;

    this.dpr = window.devicePixelRatio || 1;
    this.resizeCanvases();
    this.bindEvents();
    this.colorLUT = buildColorLUT(256);
  }

  // ── Canvas setup ───────────────────────────────────────────────────────────

  resizeCanvases() {
    for (const el of [this.waveformEl, this.spectroEl, this.ringEl]) {
      const w = Math.round(el.clientWidth  * this.dpr);
      const h = Math.round(el.clientHeight * this.dpr);
      if (el.width !== w || el.height !== h) {
        el.width  = w;
        el.height = h;
        el.getContext('2d').scale(this.dpr, this.dpr);
      }
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  bindEvents() {
    this.recordBtn.addEventListener('click', () => this.toggleRecording());
    this.fileInput.addEventListener('change', e => this.handleUpload(e));
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.stopBtn.addEventListener('click', () => this.stop());

    for (const el of [this.waveformEl, this.spectroEl, this.ringEl]) {
      el.addEventListener('mouseenter', e => this.startScrubbing(e));
      el.addEventListener('mousemove',  e => this.updateScrub(e));
      el.addEventListener('mouseleave', () => this.stopScrubbing());
    }

    const ro = new ResizeObserver(() => {
      this.resizeCanvases();
      if (this.buffer) this.renderAll();
    });
    for (const el of [this.waveformEl, this.spectroEl, this.ringEl]) ro.observe(el);
  }

  // ── Audio context (lazy) ───────────────────────────────────────────────────

  ac() {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    return this.audioCtx;
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  async toggleRecording() {
    this.isRecording ? this.stopRecording() : await this.startRecording();
  }

  async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recChunks = [];
      this.recorder  = new MediaRecorder(stream);
      this.recorder.ondataavailable = e => { if (e.data.size > 0) this.recChunks.push(e.data); };
      this.recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        await this.loadBlob(new Blob(this.recChunks, { type: this.recorder.mimeType }));
      };
      this.recorder.start(100);
      this.isRecording = true;
      this.recordBtn.textContent = 'Stop';
      this.recordBtn.classList.add('recording');
      this.setStatus('Recording…');
    } catch (err) {
      this.setStatus('Microphone unavailable: ' + err.message);
    }
  }

  stopRecording() {
    this.recorder.stop();
    this.isRecording = false;
    this.recordBtn.textContent = 'Record';
    this.recordBtn.classList.remove('recording');
    this.setStatus('Processing…');
  }

  // ── File upload ────────────────────────────────────────────────────────────

  handleUpload(e) {
    const file = e.target.files[0];
    if (file) this.loadBlob(file);
    e.target.value = '';
  }

  // ── Audio loading ──────────────────────────────────────────────────────────

  async loadBlob(blob) {
    try {
      this.setStatus('Decoding…');
      const ac  = this.ac();
      const raw = await ac.decodeAudioData(await blob.arrayBuffer());
      this.granular?.stop();
      this.buffer   = normalize10s(raw, ac);
      this.mono     = mixDown(this.buffer);
      this.granular = new GranularScrubber(ac, this.buffer);
      this.stop();
      this.setTime(0);
      this.playBtn.disabled = false;
      this.stopBtn.disabled = false;
      await this.renderAll();
    } catch (err) {
      this.setStatus('Error: ' + err.message);
      console.error(err);
    }
  }

  // ── Render pipeline ────────────────────────────────────────────────────────

  async renderAll() {
    this.waveImg  = this.renderWaveform();
    this.ringImg  = this.renderRing();
    this.spectroImg = null;
    this.setStatus('Computing spectrogram…');
    await tick();
    this.spectroImg = this.renderSpectrogram();
    const { numberOfChannels: ch, sampleRate: sr } = this.buffer;
    this.setStatus(`${DURATION}s · ${ch}ch · ${sr} Hz — hover to scrub`);
    this.drawPlayhead(this.posOffset / DURATION);
  }

  renderWaveform() {
    const el  = this.waveformEl;
    const ctx = this.wCtx;
    const cw  = el.clientWidth;
    const ch  = el.clientHeight;
    const mid = ch / 2;

    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, cw, ch);

    if (this.mono) {
      const data = this.mono;
      const spp  = data.length / cw;
      const tops = new Float32Array(cw);
      const bots = new Float32Array(cw);
      for (let x = 0; x < cw; x++) {
        const s = Math.floor(x * spp);
        const e = Math.min(Math.floor((x + 1) * spp), data.length);
        let mn = 0, mx = 0;
        for (let i = s; i < e; i++) {
          if (data[i] > mx) mx = data[i];
          if (data[i] < mn) mn = data[i];
        }
        tops[x] = mid - mx * mid * 0.9;
        bots[x] = mid - mn * mid * 0.9;
      }

      ctx.beginPath();
      ctx.moveTo(0, tops[0]);
      for (let x = 1; x < cw; x++) ctx.lineTo(x, tops[x]);
      for (let x = cw - 1; x >= 0; x--) ctx.lineTo(x, bots[x]);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, ch);
      grad.addColorStop(0,   'rgba(15, 40, 100, 0.2)');
      grad.addColorStop(0.5, 'rgba(15, 40, 100, 0.4)');
      grad.addColorStop(1,   'rgba(15, 40, 100, 0.2)');
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.strokeStyle = 'rgba(10, 30, 90, 0.85)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, tops[0]);
      for (let x = 1; x < cw; x++) ctx.lineTo(x, tops[x]);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, bots[0]);
      for (let x = 1; x < cw; x++) ctx.lineTo(x, bots[x]);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(15, 40, 100, 0.25)';
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(cw, mid);
      ctx.stroke();
    }

    return ctx.getImageData(0, 0, el.width, el.height);
  }

  renderSpectrogram() {
    const el  = this.spectroEl;
    const ctx = this.sCtx;
    const pw  = el.width;
    const ph  = el.height;
    const cw  = el.clientWidth;
    const ch  = el.clientHeight;

    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, cw, ch);

    if (!this.mono) return ctx.getImageData(0, 0, pw, ph);

    const data    = this.mono;
    const sr      = this.buffer.sampleRate;
    const numBins = FFT_SIZE / 2;
    const fNyq    = sr / 2;

    const win = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
    }
    const winSum = win.reduce((a, b) => a + b, 0);

    const logMin = Math.log10(F_MIN);
    const logMax = Math.log10(fNyq);
    const yToBin = new Uint16Array(ph);
    for (let y = 0; y < ph; y++) {
      const logF = logMax - (y / (ph - 1)) * (logMax - logMin);
      yToBin[y]  = Math.max(0, Math.min(numBins - 1,
        Math.round(Math.pow(10, logF) * FFT_SIZE / sr)));
    }

    const numFrames = Math.floor((data.length - FFT_SIZE) / HOP_SIZE) + 1;
    const img    = ctx.createImageData(pw, ph);
    const pixels = img.data;
    const LUT    = this.colorLUT;
    const re     = new Float32Array(FFT_SIZE);
    const im     = new Float32Array(FFT_SIZE);
    const mag    = new Float32Array(numBins);

    for (let f = 0; f < numFrames; f++) {
      const base = f * HOP_SIZE;
      for (let i = 0; i < FFT_SIZE; i++) {
        re[i] = (base + i < data.length ? data[base + i] : 0) * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let b = 0; b < numBins; b++) {
        mag[b] = 20 * Math.log10(
          Math.sqrt(re[b] * re[b] + im[b] * im[b]) / winSum + 1e-10
        );
      }
      const x0 = Math.round(f       * pw / numFrames);
      const x1 = Math.round((f + 1) * pw / numFrames);
      for (let x = x0; x < x1 && x < pw; x++) {
        for (let y = 0; y < ph; y++) {
          const norm = Math.max(0, Math.min(1, (mag[yToBin[y]] - DB_FLOOR) / (-DB_FLOOR)));
          const ci   = Math.round(norm * 255) * 3;
          const idx  = (y * pw + x) * 4;
          pixels[idx]     = LUT[ci];
          pixels[idx + 1] = LUT[ci + 1];
          pixels[idx + 2] = LUT[ci + 2];
          pixels[idx + 3] = 255;
        }
      }
    }

    ctx.putImageData(img, 0, 0);
    return img;
  }

  renderRing() {
    const el  = this.ringEl;
    const ctx = this.rCtx;
    const cw  = el.clientWidth;
    const ch  = el.clientHeight;

    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, cw, ch);

    if (!this.mono) return ctx.getImageData(0, 0, el.width, el.height);

    const data  = this.mono;
    const cx    = cw / 2;
    const cy    = ch / 2;
    const rMax  = Math.min(cw, ch) / 2 * 0.92;
    const R     = rMax * 0.60;   // base circle radius
    const scale = rMax * 0.38;   // amplitude 1.0 → this many px

    // Compute envelope for each angular step
    const outerR = new Float32Array(RING_STEPS);
    const innerR = new Float32Array(RING_STEPS);
    for (let i = 0; i < RING_STEPS; i++) {
      const s0 = Math.floor( i      / RING_STEPS * data.length);
      const s1 = Math.min(Math.floor((i + 1) / RING_STEPS * data.length), data.length);
      let mn = 0, mx = 0;
      for (let s = s0; s < s1; s++) {
        if (data[s] > mx) mx = data[s];
        if (data[s] < mn) mn = data[s];
      }
      outerR[i] = R + mx * scale;   // positive amplitude → expands outward
      innerR[i] = R + mn * scale;   // negative amplitude → contracts inward
    }

    // Convert angular step to canvas x,y
    const pt = (i, r) => {
      const theta = (i / RING_STEPS) * 2 * Math.PI - Math.PI / 2;
      return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)];
    };

    // Filled band: outer path forward → seam → inner path backward
    ctx.beginPath();
    let [x, y] = pt(0, outerR[0]);
    ctx.moveTo(x, y);
    for (let i = 1; i < RING_STEPS; i++) {
      [x, y] = pt(i, outerR[i]);
      ctx.lineTo(x, y);
    }
    [x, y] = pt(RING_STEPS - 1, innerR[RING_STEPS - 1]);
    ctx.lineTo(x, y);
    for (let i = RING_STEPS - 2; i >= 0; i--) {
      [x, y] = pt(i, innerR[i]);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(15, 40, 100, 0.3)';
    ctx.fill();

    // Outer and inner edge strokes
    ctx.strokeStyle = 'rgba(10, 30, 90, 0.85)';
    ctx.lineWidth   = 1;

    ctx.beginPath();
    [x, y] = pt(0, outerR[0]);
    ctx.moveTo(x, y);
    for (let i = 1; i < RING_STEPS; i++) { [x, y] = pt(i, outerR[i]); ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.stroke();

    ctx.beginPath();
    [x, y] = pt(0, innerR[0]);
    ctx.moveTo(x, y);
    for (let i = 1; i < RING_STEPS; i++) { [x, y] = pt(i, innerR[i]); ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.stroke();

    // Base circle (zero amplitude reference)
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(15, 40, 100, 0.2)';
    ctx.stroke();

    return ctx.getImageData(0, 0, el.width, el.height);
  }

  // ── Linear playback ────────────────────────────────────────────────────────

  togglePlay() {
    this.isPlaying ? this.pause() : this.play();
  }

  play() {
    if (!this.buffer) return;
    const ac = this.ac();
    if (ac.state === 'suspended') ac.resume();

    this.source        = ac.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(ac.destination);
    this.source.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.posOffset = 0;
        this.playBtn.textContent = 'Play';
        cancelAnimationFrame(this.rafId);
        this.drawPlayhead(0);
        this.setTime(0);
      }
    };

    this.acStarted = ac.currentTime;
    this.source.start(0, this.posOffset);
    this.isPlaying = true;
    this.playBtn.textContent = 'Pause';
    this.stopBtn.disabled    = false;
    this.rafTick();
  }

  pause() {
    const ac = this.ac();
    this.posOffset = Math.min(
      this.posOffset + (ac.currentTime - this.acStarted), DURATION
    );
    this.source.onended = null;
    this.source.stop();
    this.source    = null;
    this.isPlaying = false;
    this.playBtn.textContent = 'Play';
    cancelAnimationFrame(this.rafId);
  }

  stop() {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch (_) {}
      this.source = null;
    }
    this.isPlaying = false;
    this.posOffset = 0;
    cancelAnimationFrame(this.rafId);
    this.playBtn.textContent = 'Play';
    this.playBtn.disabled    = !this.buffer;
    this.stopBtn.disabled    = true;
    if (this.buffer) { this.drawPlayhead(0); this.setTime(0); }
  }

  rafTick() {
    const pos = this.posOffset + (this.ac().currentTime - this.acStarted);
    this.drawPlayhead(Math.min(pos / DURATION, 1));
    this.setTime(pos);
    if (this.isPlaying) this.rafId = requestAnimationFrame(() => this.rafTick());
  }

  // ── Granular scrubbing ─────────────────────────────────────────────────────

  startScrubbing(e) {
    if (!this.granular) return;
    const ac = this.ac();
    if (ac.state === 'suspended') ac.resume();
    if (this.isPlaying) this.pause();
    const p = this._canvasProgress(e);
    this.granular.setPosition(p * DURATION);
    this.granular.start();
    this.drawPlayhead(p);
    this.setTime(p * DURATION);
  }

  updateScrub(e) {
    if (!this.granular?.active) return;
    const p = this._canvasProgress(e);
    this.granular.setPosition(p * DURATION);
    this.drawPlayhead(p);
    this.setTime(p * DURATION);
  }

  stopScrubbing() {
    this.granular?.stop();
  }

  _canvasProgress(e) {
    if (e.currentTarget === this.ringEl) return this._ringProgress(e);
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  _ringProgress(e) {
    const rect     = e.currentTarget.getBoundingClientRect();
    const dx       = e.clientX - rect.left  - rect.width  / 2;
    const dy       = e.clientY - rect.top   - rect.height / 2;
    const theta    = Math.atan2(dy, dx);              // −π..π, 0 = right
    let   progress = (theta + Math.PI / 2) / (2 * Math.PI);  // 0 = top, clockwise
    if (progress < 0) progress += 1;
    return progress;
  }

  // ── Playhead drawing ───────────────────────────────────────────────────────

  drawPlayhead(progress) {
    this.restoreAndLine(this.waveformEl, this.wCtx, this.waveImg,    progress);
    this.restoreAndLine(this.spectroEl,  this.sCtx, this.spectroImg, progress);
    this._drawRingPlayhead(progress);
  }

  restoreAndLine(el, ctx, img, progress) {
    if (img) {
      ctx.putImageData(img, 0, 0);
    } else {
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(0, 0, el.clientWidth, el.clientHeight);
    }
    const x = progress * el.clientWidth;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 60, 90, 0.9)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, el.clientHeight);
    ctx.stroke();
    ctx.restore();
  }

  _drawRingPlayhead(progress) {
    const el  = this.ringEl;
    const ctx = this.rCtx;

    if (this.ringImg) {
      ctx.putImageData(this.ringImg, 0, 0);
    } else {
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(0, 0, el.clientWidth, el.clientHeight);
    }

    const cw    = el.clientWidth;
    const ch    = el.clientHeight;
    const cx    = cw / 2;
    const cy    = ch / 2;
    const rMax  = Math.min(cw, ch) / 2 * 0.92;
    const R     = rMax * 0.60;
    const theta = progress * 2 * Math.PI - Math.PI / 2;
    const cosT  = Math.cos(theta);
    const sinT  = Math.sin(theta);

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 60, 90, 0.9)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + R    * cosT, cy + R    * sinT);
    ctx.lineTo(cx + rMax * cosT, cy + rMax * sinT);
    ctx.stroke();
    ctx.restore();
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  setTime(pos) {
    const p = Math.max(0, Math.min(DURATION, pos));
    this.timeDisplay.textContent = `${p.toFixed(1)}s / ${DURATION}.0s`;
  }

  setStatus(msg) {
    this.statusEl.textContent = msg;
  }
}

// ── Pure functions ─────────────────────────────────────────────────────────

function normalize10s(audioBuf, ac) {
  const sr    = audioBuf.sampleRate;
  const frames = DURATION * sr;
  const nc    = audioBuf.numberOfChannels;
  const out   = ac.createBuffer(nc, frames, sr);
  for (let c = 0; c < nc; c++) {
    const src = audioBuf.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, Math.min(src.length, frames)));
  }
  return out;
}

function mixDown(audioBuf) {
  const len = audioBuf.length;
  const nc  = audioBuf.numberOfChannels;
  const out = new Float32Array(len);
  for (let c = 0; c < nc; c++) {
    const ch = audioBuf.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += ch[i] / nc;
  }
  return out;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr  = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const ur = re[i+j],        ui = im[i+j];
        const vr = re[i+j+half]*cr - im[i+j+half]*ci;
        const vi = re[i+j+half]*ci + im[i+j+half]*cr;
        re[i+j]      = ur + vr;  im[i+j]      = ui + vi;
        re[i+j+half] = ur - vr;  im[i+j+half] = ui - vi;
        const ncr = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = ncr;
      }
    }
  }
}

function buildColorLUT(n) {
  const stops = [
    [236, 241, 248],
    [180, 210, 235],
    [ 95, 160, 215],
    [ 30,  95, 185],
    [ 10,  45, 130],
    [  4,  15,  65],
    [  1,   3,  18],
  ];
  const lut = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t    = (i / (n - 1)) * (stops.length - 1);
    const lo   = Math.floor(t);
    const hi   = Math.min(lo + 1, stops.length - 1);
    const frac = t - lo;
    lut[i*3]   = Math.round(stops[lo][0] + frac * (stops[hi][0] - stops[lo][0]));
    lut[i*3+1] = Math.round(stops[lo][1] + frac * (stops[hi][1] - stops[lo][1]));
    lut[i*3+2] = Math.round(stops[lo][2] + frac * (stops[hi][2] - stops[lo][2]));
  }
  return lut;
}

function tick() { return new Promise(r => setTimeout(r, 0)); }

function fmt(s) {
  if (!isFinite(s) || s < 0) return '–:––';
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

window.addEventListener('DOMContentLoaded', () => { window.__scrubber = new AudioScrubber(); });
