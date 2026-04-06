// === Constants ===
const MAX_MISTAKES_UNGUIDED = 2;
const GUIDED_ATTEMPTS = 3;
const TOTAL_ATTEMPTS = 4;
const REQUIRED_CHARS = 10;
const TV_REWARDS = [30, 20, 10]; // minutes per cycle (index 2+ = 10)

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const CEDICT_URL = 'https://cdn.jsdelivr.net/gh/krmanik/cedict-json/v2/';

// === State ===
const state = {
  characters: [],
  currentCharIndex: 0,
  completedChars: new Set(),
  score: 0,
  attemptNum: 1,
  currentMistakes: 0,
  currentStrokesCompleted: 0,
  cyclesCompleted: 0,
  tvTimeEarned: 0,
  refWriter: null,
  quizWriter: null,
  currentScreen: 'setup',
  isAnimating: false,
  dictCache: {},  // char -> { pinyin, meaning }
};

// === DOM References ===
const $ = (id) => document.getElementById(id);

const els = {
  // Setup
  charInput: $('char-input'),
  charCount: $('char-count'),
  charPreview: $('char-preview'),
  charError: $('char-error'),
  btnStart: $('btn-start'),
  // Practice
  scoreDisplay: $('score-display'),
  charIndexDisplay: $('char-index-display'),
  attemptDisplay: $('attempt-display'),
  refWriterTarget: $('ref-writer-target'),
  quizWriterTarget: $('quiz-writer-target'),
  feedbackOverlay: $('feedback-overlay'),
  btnRestart: $('btn-restart'),
  btnAnimate: $('btn-animate'),
  failDialog: $('fail-dialog'),
  btnRetryGuided: $('btn-retry-guided'),
  btnRetryUnguided: $('btn-retry-unguided'),
  successOverlay: $('success-overlay'),
  pinyinDisplay: $('pinyin-display'),
  meaningDisplay: $('meaning-display'),
  btnSpeak: $('btn-speak'),
  // Reward
  rewardTitle: $('reward-title'),
  tvTimeDisplay: $('tv-time-display'),
  tvTimeTotal: $('tv-time-total'),
  cycleInfo: $('cycle-info'),
  confettiContainer: $('confetti-container'),
  btnPlayAgain: $('btn-play-again'),
};

// === Initialization ===
function init() {
  loadProgress();

  els.charInput.addEventListener('input', validateInput);
  els.btnStart.addEventListener('click', startPractice);
  els.btnRestart.addEventListener('click', restartCurrentTrace);
  els.btnAnimate.addEventListener('click', showAnimation);
  els.btnRetryGuided.addEventListener('click', retryGuided);
  els.btnRetryUnguided.addEventListener('click', retryUnguided);
  els.btnPlayAgain.addEventListener('click', startNewCycle);
  els.btnSpeak.addEventListener('click', speakCurrentChar);

  // Prevent zoom on double tap for iOS
  document.addEventListener('dblclick', (e) => e.preventDefault());
}

document.addEventListener('DOMContentLoaded', init);

// === localStorage Persistence ===
function loadProgress() {
  try {
    const saved = localStorage.getItem('ctutor_progress');
    if (saved) {
      const data = JSON.parse(saved);
      state.cyclesCompleted = data.cyclesCompleted || 0;
      state.tvTimeEarned = data.tvTimeEarned || 0;
    }
  } catch (e) {
    // Ignore corrupt data
  }
}

function saveProgress() {
  try {
    localStorage.setItem('ctutor_progress', JSON.stringify({
      cyclesCompleted: state.cyclesCompleted,
      tvTimeEarned: state.tvTimeEarned,
    }));
  } catch (e) {
    // Ignore if localStorage unavailable
  }
}

// === Dictionary & Pinyin ===
function numPinyinToTone(s) {
  const tones = {
    a: '\u0101\u00e1\u01ce\u00e0a',
    e: '\u0113\u00e9\u011b\u00e8e',
    i: '\u012b\u00ed\u01d0\u00eci',
    o: '\u014d\u00f3\u01d2\u00f2o',
    u: '\u016b\u00fa\u01d4\u00f9u',
    v: '\u01d6\u01d8\u01da\u01dcu\u0308',
  };

  const match = s.match(/^([a-z\u00fc]+)(\d)$/i);
  if (!match) return s;

  let syl = match[1].toLowerCase().replace(/\u00fc/g, 'v');
  const tone = parseInt(match[2]);
  if (tone < 1 || tone > 5) return s;

  // Find vowel to place tone mark on
  let idx = -1;
  if (syl.includes('a')) idx = syl.indexOf('a');
  else if (syl.includes('e')) idx = syl.indexOf('e');
  else if (syl.includes('ou')) idx = syl.indexOf('o');
  else {
    for (let i = syl.length - 1; i >= 0; i--) {
      if ('aeiouv'.includes(syl[i])) { idx = i; break; }
    }
  }

  if (idx === -1) return syl;
  const vowel = syl[idx];
  const toned = tones[vowel][tone - 1];
  return syl.substring(0, idx) + toned + syl.substring(idx + 1);
}

function formatPinyin(pinyinArr) {
  if (!pinyinArr.length) return '—';
  return numPinyinToTone(pinyinArr[0]);
}

function formatMeaning(definitions) {
  const firstDef = Object.values(definitions)[0] || '';
  const parts = firstDef.split(/;\s*/).filter(Boolean);
  return parts.slice(0, 2).join('; ');
}

async function fetchDictData(chars) {
  const promises = chars.map(async (ch) => {
    if (state.dictCache[ch]) return;
    try {
      const url = CEDICT_URL + encodeURIComponent(ch) + '.json';
      console.log('[dict] fetching:', url);
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.dictCache[ch] = {
        pinyin: formatPinyin(data.pinyin || []),
        meaning: formatMeaning(data.definitions || {}),
      };
      console.log('[dict]', ch, '->', state.dictCache[ch]);
    } catch (e) {
      console.error('[dict] failed for', ch, e);
      state.dictCache[ch] = { pinyin: '—', meaning: '—' };
    }
  });
  await Promise.all(promises);
}

function updateCharDetails() {
  const char = state.characters[state.currentCharIndex];
  const info = state.dictCache[char] || { pinyin: '...', meaning: '...' };
  els.pinyinDisplay.textContent = info.pinyin;
  els.meaningDisplay.textContent = info.meaning;
}

// === Speech ===
let voicesLoaded = false;

function ensureVoicesLoaded() {
  return new Promise((resolve) => {
    const voices = speechSynthesis.getVoices();
    if (voices.length > 0) {
      voicesLoaded = true;
      resolve(voices);
      return;
    }
    speechSynthesis.addEventListener('voiceschanged', () => {
      voicesLoaded = true;
      resolve(speechSynthesis.getVoices());
    }, { once: true });
  });
}

async function speakCurrentChar() {
  const char = state.characters[state.currentCharIndex];
  if (!('speechSynthesis' in window)) return;

  speechSynthesis.cancel();

  if (!voicesLoaded) {
    await ensureVoicesLoaded();
  }

  const utterance = new SpeechSynthesisUtterance(char);
  utterance.lang = 'zh-CN';
  utterance.rate = 0.8;

  // Try to find a Chinese voice explicitly
  const voices = speechSynthesis.getVoices();
  const zhVoice = voices.find(v => v.lang.startsWith('zh'));
  if (zhVoice) {
    utterance.voice = zhVoice;
  }

  speechSynthesis.speak(utterance);
}

// === Screen Management ===
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.add('hidden');
    s.classList.remove('active');
  });
  const target = $('screen-' + screenId);
  target.classList.remove('hidden');
  target.classList.add('active');
  state.currentScreen = screenId;
}

// === Setup Screen ===
function extractCJKChars(text) {
  const chars = [];
  for (const ch of text) {
    if (CJK_REGEX.test(ch)) {
      chars.push(ch);
    }
  }
  return chars;
}

function validateInput() {
  const raw = els.charInput.value;
  const chars = extractCJKChars(raw);
  const count = chars.length;

  els.charCount.textContent = count + ' / ' + REQUIRED_CHARS + ' characters';

  // Show character preview pills
  els.charPreview.innerHTML = '';
  chars.forEach((ch) => {
    const pill = document.createElement('span');
    pill.className = 'char-pill';
    pill.textContent = ch;
    els.charPreview.appendChild(pill);
  });

  // Check for non-CJK characters
  const nonCJK = raw.replace(/[\u4e00-\u9fff\u3400-\u4dbf\s]/g, '');
  if (nonCJK.length > 0) {
    els.charError.textContent = 'Only Chinese characters are accepted';
    els.charError.classList.remove('hidden');
  } else {
    els.charError.classList.add('hidden');
  }

  if (count === REQUIRED_CHARS) {
    els.btnStart.disabled = false;
    els.charCount.style.color = '#4CAF50';
  } else {
    els.btnStart.disabled = true;
    els.charCount.style.color = count > REQUIRED_CHARS ? '#e74c3c' : '#888';
  }
}

// === Practice Screen ===
async function startPractice() {
  const chars = extractCJKChars(els.charInput.value);
  if (chars.length !== REQUIRED_CHARS) return;

  state.characters = chars;
  state.currentCharIndex = 0;
  state.completedChars = new Set();
  state.score = 0;

  // Fetch dictionary data for all characters
  els.btnStart.disabled = true;
  els.btnStart.textContent = 'Loading...';
  await fetchDictData(chars);
  els.btnStart.textContent = 'Start';

  showScreen('practice');
  initCharacter(0);
}

function calcQuizSize() {
  const container = $('practice-bottom');
  const w = container.clientWidth - 24;
  const h = container.clientHeight - 24;
  return Math.min(w, h, 350);
}

function initCharacter(index) {
  state.currentCharIndex = index;
  state.attemptNum = 1;
  state.currentMistakes = 0;
  state.currentStrokesCompleted = 0;

  const char = state.characters[index];

  updatePracticeUI();
  updateCharDetails();

  // Reference writer
  if (state.refWriter) {
    state.refWriter.setCharacter(char);
  } else {
    state.refWriter = HanziWriter.create(els.refWriterTarget, char, {
      width: 100,
      height: 100,
      padding: 5,
      strokeColor: '#333',
      outlineColor: '#ccc',
      strokeAnimationSpeed: 1,
      delayBetweenStrokes: 300,
    });
  }

  // Quiz writer — always destroy and recreate for a clean slate
  createQuizWriter(char);
}

function createQuizWriter(char) {
  // Clear previous
  els.quizWriterTarget.innerHTML = '';

  const size = calcQuizSize();
  const guided = state.attemptNum <= GUIDED_ATTEMPTS;

  state.quizWriter = HanziWriter.create(els.quizWriterTarget, char, {
    width: size,
    height: size,
    padding: 15,
    strokeColor: '#555',
    outlineColor: '#ddd',
    drawingColor: '#4CAF50',
    drawingWidth: 8,
    showOutline: guided,
    showCharacter: false,
    highlightColor: '#aaf',
    showHintAfterMisses: guided ? 3 : false,
    highlightOnComplete: false,
  });

  startQuiz();
}

function startQuiz() {
  state.currentMistakes = 0;
  state.currentStrokesCompleted = 0;

  state.quizWriter.quiz({
    onCorrectStroke: handleCorrectStroke,
    onMistake: handleMistake,
    onComplete: handleQuizComplete,
  });
}

function updatePracticeUI() {
  els.scoreDisplay.textContent = state.score + ' / ' + REQUIRED_CHARS;
  els.charIndexDisplay.textContent = 'Character ' + (state.currentCharIndex + 1);

  if (state.attemptNum <= GUIDED_ATTEMPTS) {
    els.attemptDisplay.textContent = 'Trace ' + state.attemptNum + '/' + GUIDED_ATTEMPTS;
    els.attemptDisplay.style.color = '#4a90d9';
  } else {
    els.attemptDisplay.textContent = 'Free trace!';
    els.attemptDisplay.style.color = '#e67e22';
  }
}

// === Quiz Callbacks ===
function handleCorrectStroke(data) {
  state.currentStrokesCompleted = data.strokeNum + 1;
  flashFeedback('green');
}

function handleMistake(data) {
  state.currentMistakes = data.totalMistakes;
  flashFeedback('red');
  els.quizWriterTarget.classList.add('shake');
  setTimeout(() => els.quizWriterTarget.classList.remove('shake'), 400);
}

function handleQuizComplete(data) {
  if (state.isAnimating) return;
  state.isAnimating = true;

  if (state.attemptNum <= GUIDED_ATTEMPTS) {
    // Guided attempt complete — advance to next attempt
    state.attemptNum++;
    showSuccessFlash('Nice!', () => {
      state.isAnimating = false;
      updatePracticeUI();
      createQuizWriter(state.characters[state.currentCharIndex]);
    });
  } else {
    // Unguided attempt (attempt 4)
    if (data.totalMistakes <= MAX_MISTAKES_UNGUIDED) {
      // PASSED
      markCharacterComplete();
    } else {
      // FAILED
      state.isAnimating = false;
      showFailDialog();
    }
  }
}

// === Character Completion ===
function markCharacterComplete() {
  state.completedChars.add(state.currentCharIndex);
  state.score++;

  showSuccessFlash('Correct!', () => {
    state.isAnimating = false;

    if (state.score === REQUIRED_CHARS) {
      showRewardScreen();
    } else {
      const nextIdx = nextIncompleteIndex();
      initCharacter(nextIdx);
    }
  });
}

function nextIncompleteIndex() {
  for (let i = 1; i <= REQUIRED_CHARS; i++) {
    const idx = (state.currentCharIndex + i) % REQUIRED_CHARS;
    if (!state.completedChars.has(idx)) return idx;
  }
  return 0;
}

// === Fail Dialog ===
function showFailDialog() {
  els.failDialog.classList.remove('hidden');
}

function hideFailDialog() {
  els.failDialog.classList.add('hidden');
}

function retryGuided() {
  hideFailDialog();
  state.attemptNum = 1;
  updatePracticeUI();
  createQuizWriter(state.characters[state.currentCharIndex]);
}

function retryUnguided() {
  hideFailDialog();
  state.attemptNum = TOTAL_ATTEMPTS;
  updatePracticeUI();
  createQuizWriter(state.characters[state.currentCharIndex]);
}

// === Controls ===
function restartCurrentTrace() {
  if (state.isAnimating) return;
  createQuizWriter(state.characters[state.currentCharIndex]);
}

function showAnimation() {
  if (state.isAnimating) return;
  state.isAnimating = true;

  // Animate the reference character at top
  state.refWriter.animateCharacter({
    onComplete: () => {
      state.isAnimating = false;
    },
  });
}

// === Visual Feedback ===
function flashFeedback(color) {
  const overlay = els.feedbackOverlay;
  overlay.classList.remove('hidden', 'flash-red', 'flash-green');
  // Force reflow
  void overlay.offsetWidth;
  overlay.classList.add('flash-' + color);
  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('flash-red', 'flash-green');
  }, 400);
}

function showSuccessFlash(text, callback) {
  const overlay = els.successOverlay;
  overlay.querySelector('.overlay-text').textContent = text;
  overlay.classList.remove('hidden');
  setTimeout(() => {
    overlay.classList.add('hidden');
    if (callback) callback();
  }, 1000);
}

function showError(msg) {
  els.charError.textContent = msg;
  els.charError.classList.remove('hidden');
}

// === Reward Screen ===
function showRewardScreen() {
  state.cyclesCompleted++;
  const cycleIdx = Math.min(state.cyclesCompleted - 1, TV_REWARDS.length - 1);
  const earned = TV_REWARDS[cycleIdx];
  state.tvTimeEarned += earned;
  saveProgress();

  els.tvTimeDisplay.textContent = 'You earned ' + earned + ' minutes of TV time!';
  els.tvTimeTotal.textContent = 'Total TV time: ' + state.tvTimeEarned + ' minutes';
  els.cycleInfo.textContent = 'Cycle ' + state.cyclesCompleted + ' complete';

  showScreen('reward');
  launchConfetti();
}

function startNewCycle() {
  // Clear confetti
  els.confettiContainer.innerHTML = '';

  // Destroy writers
  if (state.refWriter) {
    els.refWriterTarget.innerHTML = '';
    state.refWriter = null;
  }
  els.quizWriterTarget.innerHTML = '';
  state.quizWriter = null;

  state.isAnimating = false;

  showScreen('setup');
}

// === Confetti ===
function launchConfetti() {
  const container = els.confettiContainer;
  container.innerHTML = '';
  const colors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff8cc8', '#a855f7'];

  for (let i = 0; i < 50; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.setProperty('--x', Math.random() * 100 + 'vw');
    piece.style.setProperty('--delay', Math.random() * 0.8 + 's');
    piece.style.setProperty('--color', colors[i % colors.length]);
    piece.style.setProperty('--drift', (Math.random() - 0.5) * 200 + 'px');
    container.appendChild(piece);
  }

  setTimeout(() => {
    container.innerHTML = '';
  }, 4000);
}
