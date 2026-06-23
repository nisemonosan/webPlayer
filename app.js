(() => {
  'use strict';

  // ===== DOM参照 =====
  const audio = document.getElementById('audio');
  const mp3Input = document.getElementById('mp3-input');
  const csvInput = document.getElementById('csv-input');
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const seek = document.getElementById('seek');
  const currentTimeEl = document.getElementById('current-time');
  const durationEl = document.getElementById('duration-time');
  const trackName = document.getElementById('track-name');
  const speedButtons = document.getElementById('speed-buttons');
  const lyricsList = document.getElementById('lyrics-list');
  const lyricsCount = document.getElementById('lyrics-count');

  // 使い方ガイド DOM
  const helpBtn = document.getElementById('help-btn');
  const helpBackdrop = document.getElementById('help-backdrop');
  const helpModal = document.getElementById('help-modal');
  const helpCloseBtn = document.getElementById('help-close-btn');
  const csvSampleDownload = document.getElementById('csv-sample-download');

  // メトロノーム DOM
  const metronomeToggle = document.getElementById('metronome-toggle');
  const metroOpenBtn = document.getElementById('metro-open-btn');
  const metroCloseBtn = document.getElementById('metro-close-btn');
  const metroBackdrop = document.getElementById('metro-backdrop');
  const metroSheet = document.getElementById('metro-sheet');
  const metroSummary = document.getElementById('metro-summary');
  const metronomeMode = document.getElementById('metronome-mode');
  const metronomeBeats = document.getElementById('metronome-beats');
  const metronomeBpm = document.getElementById('metronome-bpm');
  const metronomeBpmValue = document.getElementById('metronome-bpm-value');
  const metronomeVolume = document.getElementById('metronome-volume');
  const metronomeVolumeValue = document.getElementById('metronome-volume-value');

  // ===== 状態 =====
  let lyrics = []; // {time: number(秒), raw: "mm:ss.xxx", text: string}
  let currentLyricIndex = -1;
  let isSeeking = false;
  let currentObjectURL = null;

  // メトロノーム状態
  let metronomeEnabled = false;
  let metronomeModeValue = 'A';
  let bpm = 120;
  let metronomeVol = 0.75;  // 0.0 - 1.0
  let beatsPerMeasure = 4;
  let audioCtx = null;          // 遅延初期化
  let schedulerTimer = null;    // setInterval ID
  let countInTimer = null;      // カウントイン完了用 setTimeout ID
  let nextNoteTime = 0;         // 次クリックの AudioContext 時刻
  let currentBeat = 0;          // 小節内の拍位置 (0..beats-1)
  let isCountingIn = false;     // カウントイン中フラグ
  let pendingAudioStart = false;// カウントイン後に音楽を始めるべきか

  // ===== ユーティリティ: 時間フォーマット =====
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // ===== ピッチ維持設定（ブラウザ互換） =====
  function setPreservesPitch(audioEl) {
    const props = ['preservesPitch', 'mozPreservesPitch', 'webkitPreservesPitch'];
    for (const p of props) {
      if (p in audioEl) {
        try { audioEl[p] = true; } catch (e) { /* noop */ }
      }
    }
  }

  // ===== タイムコード解析（複数形式対応） =====
  // サポート形式:
  //   "01:23.456"  -> mm:ss.xxx
  //   "01:23"      -> mm:ss
  //   "01:23:15"   -> mm:ss:ff (30fps)
  //   "83456"      -> 生ミリ秒
  //   "83.456"     -> 生秒
  function parseTimecode(raw) {
    const s = String(raw).trim();
    if (!s) return null;

    // コロン含む: mm:ss or mm:ss.xxx or mm:ss:ff
    if (s.includes(':')) {
      const parts = s.split(':');
      // h:mm:ss 対応（3コロンで最後がフレームでない場合）
      if (parts.length === 3) {
        // mm:ss:ff を想定。ただし最後が小数を含むなら mm:ss.mmm 扱い不可（コロン区切りなので）
        const mm = parseInt(parts[0], 10);
        const ss = parseInt(parts[1], 10);
        const ff = parseFloat(parts[2]);
        if (isNaN(mm) || isNaN(ss) || isNaN(ff)) return null;
        // 最後の要素が >= 30 または小数の場合は秒扱いにフォールバック（柔軟性）
        if (ff < 30 && parts[2].indexOf('.') === -1) {
          // 30fpsのフレーム数として解釈
          return mm * 60 + ss + ff / 30;
        }
        // そうでなければ3パート目は秒の延長として扱う (h:mm:ss 形式)
        return mm * 3600 + ss * 60 + ff;
      }
      if (parts.length === 2) {
        const mm = parseInt(parts[0], 10);
        const ssRest = parts[1];
        if (isNaN(mm)) return null;
        // ss.xxx or ss
        if (ssRest.indexOf('.') !== -1) {
          const ssFloat = parseFloat(ssRest);
          if (isNaN(ssFloat)) return null;
          return mm * 60 + ssFloat;
        }
        const ss = parseInt(ssRest, 10);
        if (isNaN(ss)) return null;
        return mm * 60 + ss;
      }
      return null;
    }

    // コロンなし: 数値のみ
    const num = parseFloat(s);
    if (isNaN(num)) return null;
    // 小数含む場合は秒、整数のみの場合は5桁以上(10000=10000ms=10s)など曖昧だが
    // 実用的には「整数のみ」=ミリ秒、「小数」=秒 とみなす
    if (s.indexOf('.') !== -1) {
      return num; // 秒
    }
    // 整数: 1000以上はミリ秒、未満は秒とみなす（直感的）
    return num >= 1000 ? num / 1000 : num;
  }

  // タイムコード表示用フォーマット（入力値を維持しつつ正規化）
  function formatTimecodeLabel(sec) {
    return formatTime(sec);
  }

  // ===== メトロノーム =====
  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function clickAt(ctx, time, isDownbeat) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = isDownbeat ? 1000 : 800;
    const vol = metronomeVol * 1.5;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(vol, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  const LOOKAHEAD_MS = 25;
  const SCHEDULE_AHEAD = 0.1;

  function scheduler() {
    const ctx = ensureAudioCtx();
    while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
      clickAt(ctx, nextNoteTime, currentBeat === 0);
      const secondsPerBeat = 60.0 / bpm;
      nextNoteTime += secondsPerBeat;
      currentBeat = (currentBeat + 1) % beatsPerMeasure;
    }
  }

  function startMetronome(resetBeat = true) {
    const ctx = ensureAudioCtx();
    if (resetBeat) { currentBeat = 0; }
    nextNoteTime = ctx.currentTime + 0.1;
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(scheduler, LOOKAHEAD_MS);
  }

  function stopMetronome() {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    if (countInTimer) { clearTimeout(countInTimer); countInTimer = null; }
    currentBeat = 0;
  }

  // カウントイン開始: N拍カウント → 次の拍（N+1拍目）で音源再生（クリックなし）
  function startCountIn() {
    const ctx = ensureAudioCtx();
    const secondsPerBeat = 60.0 / bpm;
    const firstClickTime = ctx.currentTime + 0.1;
    // N拍カウントの次の拍（クリックなし）で音源開始
    const audioStartTime = firstClickTime + beatsPerMeasure * secondsPerBeat;
    // メトロノーム停止タイミング（音源開始の少し手前）
    const metronomeStopTime = audioStartTime - 0.05;
    const delayMs = Math.max(0, (metronomeStopTime - ctx.currentTime) * 1000);

    isCountingIn = true;
    pendingAudioStart = true;
    startMetronome(true);

    // 音源開始直前: Mode Aはメトロノーム停止、Mode Cは継続
    countInTimer = setTimeout(() => {
      countInTimer = null;
      if (metronomeModeValue === 'A') stopMetronome();
      finishCountIn(); // audio.play() 呼び出し
    }, delayMs);
  }

  function finishCountIn() {
    isCountingIn = false;
    if (metronomeModeValue === 'A') stopMetronome();
    if (pendingAudioStart) {
      pendingAudioStart = false;
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  function playAudioOnly() {
    const p = audio.play();
    if (p && p.catch) p.catch(err => console.warn('Play failed:', err));
  }

  // ===== CSV解析 =====
  function parseCSV(text) {
    const lines = text.split(/\r?\n/);
    const result = [];
    for (let raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#') || line.startsWith('//')) continue;

      // 最初のカンマで分割（歌詞内のカンマを保護）
      const commaIdx = line.indexOf(',');
      if (commaIdx === -1) continue;

      const timeRaw = line.slice(0, commaIdx).trim();
      const textPart = line.slice(commaIdx + 1).trim();

      const time = parseTimecode(timeRaw);
      if (time === null || time < 0) continue;
      if (!textPart) continue;

      result.push({ time, raw: timeRaw, text: textPart });
    }
    // 時間順にソート
    result.sort((a, b) => a.time - b.time);
    return result;
  }

  // ===== 歌詞リスト描画 =====
  function renderLyrics() {
    lyricsList.innerHTML = '';
    if (lyrics.length === 0) {
      const li = document.createElement('li');
      li.className = 'lyrics-empty';
      li.textContent = 'CSVを読み込むと歌詞が表示されます';
      lyricsList.appendChild(li);
      currentLyricIndex = -1;
      return;
    }

    const frag = document.createDocumentFragment();
    lyrics.forEach((lyr, i) => {
      const li = document.createElement('li');
      li.dataset.index = String(i);

      const timeEl = document.createElement('span');
      timeEl.className = 'lyric-time';
      timeEl.textContent = formatTimecodeLabel(lyr.time);

      const textEl = document.createElement('span');
      textEl.className = 'lyric-text';
      textEl.textContent = lyr.text;

      li.appendChild(timeEl);
      li.appendChild(textEl);
      li.addEventListener('click', () => onLyricClick(i));
      frag.appendChild(li);
    });
    lyricsList.appendChild(frag);
    currentLyricIndex = -1;
    // 初期状態は全てfar相当に
    lyricsList.querySelectorAll('li[data-index]').forEach(li => {
      li.classList.add('far');
    });
  }

  // 現在再生中の歌詞を更新（距離クラス + 自動スクロール）
  function updateCurrentLyric() {
    if (lyrics.length === 0) return;
    const t = audio.currentTime;
    let idx = -1;
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].time <= t) idx = i;
      else break;
    }
    if (idx === currentLyricIndex) return;
    currentLyricIndex = idx;

    const items = lyricsList.querySelectorAll('li[data-index]');
    items.forEach((li, i) => {
      const dist = Math.abs(i - idx);
      li.classList.remove('current', 'near', 'far');
      if (i === idx) {
        li.classList.add('current');
      } else if (dist <= 1) {
        li.classList.add('near');
      } else {
        li.classList.add('far');
      }
    });

    if (idx >= 0) {
      const el = lyricsList.querySelector('li[data-index="' + idx + '"]');
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  // ===== 歌詞タップでシーク =====
  function onLyricClick(i) {
    if (!audio.src) return;
    const lyr = lyrics[i];
    if (!lyr) return;
    const wasPlaying = !audio.paused;
    audio.currentTime = lyr.time;
    // 再生中だった場合のみ再生継続
    if (wasPlaying) {
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => { /* ユーザーが再生ボタンを押す必要がある場合 */ });
      }
    }
  }

  // ===== MP3読込 =====
  function loadMP3(file) {
    if (currentObjectURL) {
      URL.revokeObjectURL(currentObjectURL);
    }
    currentObjectURL = URL.createObjectURL(file);
    audio.src = currentObjectURL;
    audio.load();

    trackName.textContent = file.name;
    playBtn.disabled = false;
    seek.disabled = false;
    seek.value = 0;

    // ファイルボタンにロード済み表示
    mp3Input.parentElement.classList.add('loaded');
  }

  // ===== CSV読込 =====
  function loadCSV(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseCSV(e.target.result);
        lyrics = parsed;
        renderLyrics();
        csvInput.parentElement.classList.add('loaded');
      } catch (err) {
        alert('CSVの解析に失敗しました: ' + err.message);
      }
    };
    reader.onerror = () => {
      alert('CSVファイルの読み込みに失敗しました');
    };
    reader.readAsText(file, 'UTF-8');
  }

  // ===== イベント: ファイル入力 =====
  mp3Input.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadMP3(file);
  });

  csvInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadCSV(file);
  });

  // ===== イベント: 再生ボタン =====
  playBtn.addEventListener('click', () => {
    if (!audio.src) return;
    // カウントイン中の押下はキャンセル扱い
    if (isCountingIn) {
      isCountingIn = false;
      pendingAudioStart = false;
      stopMetronome();
      return;
    }
    if (audio.paused) {
      if (!metronomeEnabled) {
        playAudioOnly();
      } else if (metronomeModeValue === 'B') {
        startMetronome(true);
        playAudioOnly();
      } else {
        // モードA/C: カウントイン
        startCountIn();
      }
    } else {
      audio.pause();
      if (metronomeEnabled && metronomeModeValue !== 'A') stopMetronome();
      if (isCountingIn) { isCountingIn = false; pendingAudioStart = false; stopMetronome(); }
    }
  });

  // ===== イベント: 音声要素 =====
  audio.addEventListener('play', () => {
    playBtn.classList.add('playing');
  });

  audio.addEventListener('pause', () => {
    playBtn.classList.remove('playing');
    if (metronomeEnabled && metronomeModeValue !== 'A') stopMetronome();
  });

  audio.addEventListener('loadedmetadata', () => {
    durationEl.textContent = formatTime(audio.duration);
    seek.max = Math.max(1, Math.floor(audio.duration * 1000));
  });

  audio.addEventListener('durationchange', () => {
    durationEl.textContent = formatTime(audio.duration);
    seek.max = Math.max(1, Math.floor(audio.duration * 1000));
  });

  audio.addEventListener('timeupdate', () => {
    if (!isSeeking) {
      seek.value = String(Math.floor(audio.currentTime * 1000));
      currentTimeEl.textContent = formatTime(audio.currentTime);
    }
    updateCurrentLyric();
  });

  audio.addEventListener('ended', () => {
    playBtn.classList.remove('playing');
    if (metronomeEnabled && metronomeModeValue !== 'A') stopMetronome();
  });

  // ===== イベント: シークバー =====
  seek.addEventListener('input', (e) => {
    isSeeking = true;
    const ms = parseInt(e.target.value, 10);
    const sec = ms / 1000;
    currentTimeEl.textContent = formatTime(sec);
  });

  // ホバー時も進行フィルを更新（ツマみ拡大時の視覚的フィードバック）
  seek.addEventListener('mouseenter', updateSeekFill);

  seek.addEventListener('change', (e) => {
    const ms = parseInt(e.target.value, 10);
    audio.currentTime = ms / 1000;
    isSeeking = false;
    updateCurrentLyric();
  });

  // タッチ終了でも change が発火しないブラウザ向け
  seek.addEventListener('touchend', () => {
    if (isSeeking) {
      audio.currentTime = parseInt(seek.value, 10) / 1000;
      isSeeking = false;
        updateCurrentLyric();
    }
  });

  // ===== イベント: 速度プリセット =====
  speedButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-rate]');
    if (!btn) return;
    const rate = parseFloat(btn.dataset.rate);
    if (isNaN(rate)) return;

    audio.playbackRate = rate;
    setPreservesPitch(audio); // 速度変更後にピッチ維持を再保証

    speedButtons.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // 初期ピッチ維持設定
  setPreservesPitch(audio);

  // ===== メトロノーム UI イベント =====
  // サマリー表示更新
  function updateMetroSummary() {
    metroSummary.textContent = metronomeModeValue + ' · ' + beatsPerMeasure + ' · ' + bpm;
  }

  // トグル（iOSスイッチ）
  metronomeToggle.addEventListener('change', () => {
    metronomeEnabled = metronomeToggle.checked;
    metroOpenBtn.disabled = !metronomeEnabled;
    if (metronomeEnabled) {
      // ユーザージェスチャ内で AudioContext を初期化・レジューム
      ensureAudioCtx();
    } else {
      closeMetroSheet();
      stopMetronome();
      isCountingIn = false;
      pendingAudioStart = false;
    }
  });

  // ボトムシート開閉
  function openMetroSheet() {
    metroSheet.classList.add('open');
    metroBackdrop.classList.add('open');
  }
  function closeMetroSheet() {
    metroSheet.classList.remove('open');
    metroBackdrop.classList.remove('open');
  }
  metroOpenBtn.addEventListener('click', () => {
    if (!metronomeEnabled) return;
    openMetroSheet();
  });
  metroCloseBtn.addEventListener('click', closeMetroSheet);
  metroBackdrop.addEventListener('click', closeMetroSheet);

  // モードセグメント
  metronomeMode.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    metronomeModeValue = btn.dataset.mode;
    metronomeMode.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateMetroSummary();
  });

  // 拍数セグメント
  metronomeBeats.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-beats]');
    if (!btn) return;
    beatsPerMeasure = parseInt(btn.dataset.beats, 10);
    if (!schedulerTimer) currentBeat = 0;
    metronomeBeats.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateMetroSummary();
  });

  // BPM スライダー
  metronomeBpm.addEventListener('input', (e) => {
    bpm = parseInt(e.target.value, 10);
    metronomeBpmValue.textContent = bpm;
    updateMetroSummary();
  });

  // 音量スライダー
  metronomeVolume.addEventListener('input', (e) => {
    metronomeVol = parseInt(e.target.value, 10) / 100;
    metronomeVolumeValue.textContent = e.target.value + '%';
  });

  // ===== 使い方ガイドモーダル =====
  function openHelpModal() {
    helpModal.classList.add('open');
    helpBackdrop.classList.add('open');
  }
  function closeHelpModal() {
    helpModal.classList.remove('open');
    helpBackdrop.classList.remove('open');
  }
  helpBtn.addEventListener('click', openHelpModal);
  helpCloseBtn.addEventListener('click', closeHelpModal);
  helpBackdrop.addEventListener('click', closeHelpModal);

  // ===== サンプルCSVダウンロード =====
  csvSampleDownload.addEventListener('click', () => {
    const sampleCSV = `00:00.00,instrumental
00:03.00,
00:05.50,♪
00:08.00,勇気を出して
00:11.50,一歩踏み出せば
00:15.00,新しい世界が
00:18.50,君を待ってる
00:22.00,
00:25.00,恐れずに
00:28.00,信じて進もう
00:31.50,光の方へ
00:35.00,
00:38.50,夢を叶えよう
00:42.00,今すぐに
`;
    const blob = new Blob([sampleCSV], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'サンプル歌詞.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  // ===== シークバー進捗更新 =====
  function updateSeekFill() {
    // CSS変数で進捗を設定（将来的なスタイル用）
    const percent = (seek.value / seek.max) * 100;
    seek.style.setProperty('--progress', percent + '%');
  }

  // ===== フローティングコントローラー高さをCSS変数へ同期 =====
  // 歌詞リストがコントローラーに隠れないよう、main の padding-bottom を動的調整
  const controller = document.getElementById('floating-controller');
  function syncControllerHeight() {
    if (!controller) return;
    const h = controller.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--controller-h', Math.ceil(h) + 'px');
  }
  syncControllerHeight();
  updateSeekFill(); // 初期状態のシークバー進行表示をセット
  window.addEventListener('resize', syncControllerHeight);
  window.addEventListener('orientationchange', syncControllerHeight);
  // 動画/音声メタデータ読込後にレイアウトが変わる可能性があるため
  audio.addEventListener('loadedmetadata', syncControllerHeight);
  // フォント遅延読込等の safety net
  if (typeof ResizeObserver !== 'undefined' && controller) {
    const ro = new ResizeObserver(syncControllerHeight);
    ro.observe(controller);
  }
})();
