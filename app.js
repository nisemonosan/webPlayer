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

  // ===== 状態 =====
  let lyrics = []; // {time: number(秒), raw: "mm:ss.xxx", text: string}
  let currentLyricIndex = -1;
  let isSeeking = false;
  let currentObjectURL = null;

  // ===== ユーティリティ: 時間フォーマット =====
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // ===== シークバー進行率の動的背景（Apple風プログレスバー） =====
  function updateSeekFill() {
    if (!seek) return;
    const min = parseFloat(seek.min) || 0;
    const max = parseFloat(seek.max) || 1000;
    const val = parseFloat(seek.value) || 0;
    const pct = ((val - min) / (max - min)) * 100;
    seek.style.background =
      `linear-gradient(to right, #fff 0%, #fff ${pct}%, rgba(255,255,255,0.15) ${pct}%, rgba(255,255,255,0.15) 100%)`;
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

  // ===== 歌詞タップでシーク + 再生 =====
  function onLyricClick(i) {
    if (!audio.src) return;
    const lyr = lyrics[i];
    if (!lyr) return;
    audio.currentTime = lyr.time;
    // iOS Safari のアンロック兼、即時再生で現場の体感向上
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => { /* ユーザーが再生ボタンを押す必要がある場合 */ });
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
    if (audio.paused) {
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(err => {
          console.warn('Play failed:', err);
        });
      }
    } else {
      audio.pause();
    }
  });

  // ===== イベント: 音声要素 =====
  audio.addEventListener('play', () => {
    playIcon.textContent = '⏸';
    playBtn.classList.add('playing');
  });

  audio.addEventListener('pause', () => {
    playIcon.textContent = '▶';
    playBtn.classList.remove('playing');
  });

  audio.addEventListener('loadedmetadata', () => {
    durationEl.textContent = formatTime(audio.duration);
    seek.max = Math.max(1, Math.floor(audio.duration * 1000));
    updateSeekFill();
  });

  audio.addEventListener('durationchange', () => {
    durationEl.textContent = formatTime(audio.duration);
    seek.max = Math.max(1, Math.floor(audio.duration * 1000));
    updateSeekFill();
  });

  audio.addEventListener('timeupdate', () => {
    if (!isSeeking) {
      seek.value = String(Math.floor(audio.currentTime * 1000));
      currentTimeEl.textContent = formatTime(audio.currentTime);
    }
    updateCurrentLyric();
  });

  audio.addEventListener('ended', () => {
    playIcon.textContent = '▶';
    playBtn.classList.remove('playing');
  });

  // ===== イベント: シークバー =====
  seek.addEventListener('input', (e) => {
    isSeeking = true;
    const ms = parseInt(e.target.value, 10);
    const sec = ms / 1000;
    currentTimeEl.textContent = formatTime(sec);
    updateSeekFill();
  });

  // ホバー時も進行フィルを更新（ツマみ拡大時の視覚的フィードバック）
  seek.addEventListener('mouseenter', updateSeekFill);

  seek.addEventListener('change', (e) => {
    const ms = parseInt(e.target.value, 10);
    audio.currentTime = ms / 1000;
    isSeeking = false;
    updateSeekFill();
    updateCurrentLyric();
  });

  // タッチ終了でも change が発火しないブラウザ向け
  seek.addEventListener('touchend', () => {
    if (isSeeking) {
      audio.currentTime = parseInt(seek.value, 10) / 1000;
      isSeeking = false;
      updateSeekFill();
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
