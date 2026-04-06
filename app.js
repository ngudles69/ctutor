// ============================================
// STORAGE LAYER
// Abstracted so it can be swapped to a server
// API with SQLite/login in the future.
// ============================================
const Storage = {
  _data: null,
  _KEY: 'ctutor_data',

  _load() {
    if (this._data) return this._data;
    try {
      const raw = localStorage.getItem(this._KEY);
      this._data = raw ? JSON.parse(raw) : this._default();
    } catch (e) {
      this._data = this._default();
    }
    return this._data;
  },

  _save() {
    try {
      localStorage.setItem(this._KEY, JSON.stringify(this._data));
    } catch (e) { /* ignore */ }
  },

  _default() {
    return { pin: '1357', lessons: [] };
  },

  // PIN
  getPin()       { return this._load().pin; },
  setPin(pin)    { this._load().pin = pin; this._save(); },

  // Lessons
  getLessons()       { return this._load().lessons; },
  getLesson(id)      { return this.getLessons().find(l => l.id === id); },

  createLesson(name, characters) {
    const lesson = {
      id: 'l_' + Date.now(),
      name: name,
      characters: characters,
      createdAt: Date.now(),
      completions: [],
    };
    this._load().lessons.push(lesson);
    this._save();
    return lesson;
  },

  updateLesson(id, name, characters) {
    const lesson = this.getLesson(id);
    if (!lesson) return;
    lesson.name = name;
    lesson.characters = characters;
    this._save();
  },

  deleteLesson(id) {
    const data = this._load();
    data.lessons = data.lessons.filter(l => l.id !== id);
    this._save();
  },

  // Completions
  addCompletion(lessonId, completion) {
    const lesson = this.getLesson(lessonId);
    if (!lesson) return null;
    completion.id = 'c_' + Date.now();
    completion.date = Date.now();
    lesson.completions.push(completion);
    this._save();
    return completion;
  },

  markClaimed(lessonId, completionId, claimed) {
    const lesson = this.getLesson(lessonId);
    if (!lesson) return;
    const comp = lesson.completions.find(c => c.id === completionId);
    if (comp) {
      comp.claimed = claimed;
      this._save();
    }
  },

  // Computed
  getUnclaimedBalance() {
    return this.getLessons().reduce((sum, l) =>
      sum + l.completions.filter(c => !c.claimed).reduce((s, c) => s + c.tvEarned, 0)
    , 0);
  },

  getTotalEarned() {
    return this.getLessons().reduce((sum, l) =>
      sum + l.completions.reduce((s, c) => s + c.tvEarned, 0)
    , 0);
  },

  getNextReward(lessonId) {
    const lesson = this.getLesson(lessonId);
    if (!lesson) return TV_REWARDS[TV_REWARDS.length - 1];
    const cycle = lesson.completions.length;
    return TV_REWARDS[Math.min(cycle, TV_REWARDS.length - 1)];
  },
};

// ============================================
// CONSTANTS
// ============================================
const TV_REWARDS = [30, 20, 10];
const MAX_MISTAKES_UNGUIDED = 2;
const GUIDED_ATTEMPTS = 3;
const TOTAL_ATTEMPTS = 4;
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const CEDICT_URL = 'https://cdn.jsdelivr.net/gh/krmanik/cedict-json/v2/';

// ============================================
// STATE
// ============================================
const state = {
  mode: null,         // 'learner' | 'parent'
  currentLessonId: null,
  // Practice state
  characters: [],
  currentCharIndex: 0,
  completedChars: new Set(),
  score: 0,
  attemptNum: 1,
  guidedTotal: GUIDED_ATTEMPTS,
  currentMistakes: 0,
  currentStrokesCompleted: 0,
  refWriter: null,
  quizWriter: null,
  isAnimating: false,
  dictCache: {},
  // Edit state
  editingLessonId: null,
  // Navigation
  navStack: [],
};

// ============================================
// DOM REFERENCES
// ============================================
const $ = (id) => document.getElementById(id);

const els = {
  topBar: $('top-bar'),
  topTitle: $('top-title'),
  btnBack: $('btn-back'),
  btnModeSwitch: $('btn-mode-switch'),
  // Home
  btnEnterLearner: $('btn-enter-learner'),
  btnEnterParent: $('btn-enter-parent'),
  // PIN
  pinInput: $('pin-input'),
  pinError: $('pin-error'),
  btnPinSubmit: $('btn-pin-submit'),
  btnPinCancel: $('btn-pin-cancel'),
  // Learner
  balanceAmount: $('balance-amount'),
  lessonListLearner: $('lesson-list-learner'),
  noLessonsLearner: $('no-lessons-learner'),
  // Parent
  statLessons: $('stat-lessons'),
  statUnclaimed: $('stat-unclaimed'),
  statTotal: $('stat-total'),
  lessonListParent: $('lesson-list-parent'),
  noLessonsParent: $('no-lessons-parent'),
  btnAddLesson: $('btn-add-lesson'),
  btnChangePin: $('btn-change-pin'),
  // Create/Edit lesson
  lessonNameInput: $('lesson-name-input'),
  lessonCharsInput: $('lesson-chars-input'),
  lessonCharCount: $('lesson-char-count'),
  lessonCharPreview: $('lesson-char-preview'),
  lessonError: $('lesson-error'),
  btnSaveLesson: $('btn-save-lesson'),
  btnCancelLesson: $('btn-cancel-lesson'),
  // Lesson Review
  reviewName: $('review-name'),
  reviewChars: $('review-chars'),
  reviewCompletions: $('review-completions'),
  noCompletions: $('no-completions'),
  btnEditLesson: $('btn-edit-lesson'),
  btnDeleteLesson: $('btn-delete-lesson'),
  // Change PIN
  currentPinInput: $('current-pin-input'),
  newPinInput: $('new-pin-input'),
  confirmPinInput: $('confirm-pin-input'),
  pinChangeError: $('pin-change-error'),
  btnSavePin: $('btn-save-pin'),
  btnCancelPin: $('btn-cancel-pin'),
  // Practice
  scoreDisplay: $('score-display'),
  charIndexDisplay: $('char-index-display'),
  attemptDisplay: $('attempt-display'),
  refWriterTarget: $('ref-writer-target'),
  quizWriterTarget: $('quiz-writer-target'),
  feedbackOverlay: $('feedback-overlay'),
  pinyinDisplay: $('pinyin-display'),
  meaningDisplay: $('meaning-display'),
  btnSpeak: $('btn-speak'),
  btnRestart: $('btn-restart'),
  btnAnimate: $('btn-animate'),
  failDialog: $('fail-dialog'),
  btnRetryGuided: $('btn-retry-guided'),
  btnRetryUnguided: $('btn-retry-unguided'),
  successOverlay: $('success-overlay'),
  // Reward
  tvTimeDisplay: $('tv-time-display'),
  tvTimeTotal: $('tv-time-total'),
  confettiContainer: $('confetti-container'),
  btnBackToLessons: $('btn-back-to-lessons'),
};

// ============================================
// INITIALIZATION
// ============================================
function init() {
  // Home
  els.btnEnterLearner.addEventListener('click', () => enterLearnerMode());
  els.btnEnterParent.addEventListener('click', () => showPinEntry('parent'));
  // Top bar
  els.btnBack.addEventListener('click', navBack);
  els.btnModeSwitch.addEventListener('click', handleModeSwitch);
  // PIN
  els.btnPinSubmit.addEventListener('click', submitPin);
  els.btnPinCancel.addEventListener('click', () => navigateTo('home'));
  els.pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });
  // Parent
  els.btnAddLesson.addEventListener('click', () => showCreateLesson());
  els.btnChangePin.addEventListener('click', () => navigateTo('change-pin', 'Change PIN'));
  // Create/Edit lesson
  els.lessonCharsInput.addEventListener('input', validateLessonInput);
  els.lessonNameInput.addEventListener('input', validateLessonInput);
  els.btnSaveLesson.addEventListener('click', saveLesson);
  els.btnCancelLesson.addEventListener('click', navBack);
  // Lesson Review
  els.btnEditLesson.addEventListener('click', editCurrentLesson);
  els.btnDeleteLesson.addEventListener('click', deleteCurrentLesson);
  // Change PIN
  els.btnSavePin.addEventListener('click', saveNewPin);
  els.btnCancelPin.addEventListener('click', navBack);
  // Practice
  els.btnRestart.addEventListener('click', restartCurrentTrace);
  els.btnAnimate.addEventListener('click', showAnimation);
  els.btnGuided = $('btn-guided');
  els.btnGuided.addEventListener('click', switchToGuided);
  els.btnSpeak.addEventListener('click', speakCurrentChar);
  els.btnRetryGuided.addEventListener('click', retryGuided);
  els.btnRetryUnguided.addEventListener('click', retryUnguided);
  // Reward
  els.btnBackToLessons.addEventListener('click', () => {
    navigateTo('learner', 'Lessons');
  });
  // Prevent zoom
  document.addEventListener('dblclick', (e) => e.preventDefault());
}

document.addEventListener('DOMContentLoaded', init);

// ============================================
// NAVIGATION
// ============================================
function navigateTo(screenId, title, opts) {
  opts = opts || {};

  // Hide all screens
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.add('hidden');
    s.classList.remove('active');
  });

  // Show/hide top bar
  const showTopBar = screenId !== 'home';
  els.topBar.classList.toggle('hidden', !showTopBar);

  // Target screen
  const target = $('screen-' + screenId);
  target.classList.remove('hidden');
  target.classList.add('active');
  target.classList.toggle('has-topbar', showTopBar);

  // Top bar content
  if (showTopBar) {
    els.topTitle.textContent = title || '';
    // Hide back on dashboards (learner/parent) — they use mode switch to go home
    const showBack = !['learner', 'parent'].includes(screenId);
    els.btnBack.classList.toggle('invisible', !showBack);
  }

  // Push to nav stack (unless replacing)
  if (!opts.replace) {
    state.navStack.push({ screenId, title });
  }

  // Screen-specific setup
  if (screenId === 'learner') renderLearnerDashboard();
  if (screenId === 'parent') renderParentDashboard();
}

function navBack() {
  if (state.navStack.length > 1) {
    state.navStack.pop();
    const prev = state.navStack[state.navStack.length - 1];
    navigateTo(prev.screenId, prev.title, { replace: true });
  } else {
    navigateTo('home');
  }
}

function handleModeSwitch() {
  if (state.mode === 'learner') {
    // Learner -> Parent: needs PIN
    showPinEntry('parent');
  } else {
    // Parent -> Learner: instant
    enterLearnerMode();
  }
}

// ============================================
// MODE ENTRY
// ============================================
function enterLearnerMode() {
  state.mode = 'learner';
  state.navStack = [];
  navigateTo('learner', 'Lessons');
}

function enterParentMode() {
  state.mode = 'parent';
  state.navStack = [];
  navigateTo('parent', 'Parent / Teacher');
}

// ============================================
// PIN ENTRY
// ============================================
let pinTarget = null; // 'parent' — what to do after PIN success

function showPinEntry(target) {
  pinTarget = target;
  els.pinInput.value = '';
  els.pinError.classList.add('hidden');
  navigateTo('pin', 'Enter PIN');
  setTimeout(() => els.pinInput.focus(), 100);
}

function submitPin() {
  const entered = els.pinInput.value;
  if (entered === Storage.getPin()) {
    els.pinError.classList.add('hidden');
    if (pinTarget === 'parent') {
      enterParentMode();
    }
  } else {
    els.pinError.textContent = 'Incorrect PIN';
    els.pinError.classList.remove('hidden');
    els.pinInput.value = '';
    els.pinInput.focus();
  }
}

// ============================================
// LEARNER DASHBOARD
// ============================================
function renderLearnerDashboard() {
  const balance = Storage.getUnclaimedBalance();
  els.balanceAmount.textContent = balance + ' min';

  const lessons = Storage.getLessons();
  els.lessonListLearner.innerHTML = '';
  els.noLessonsLearner.classList.toggle('hidden', lessons.length > 0);

  lessons.forEach(lesson => {
    const nextReward = Storage.getNextReward(lesson.id);
    const completions = lesson.completions.length;
    const card = document.createElement('div');
    card.className = 'lesson-card';
    card.innerHTML =
      '<div class="lesson-card-header">' +
        '<div class="lesson-card-name">' + esc(lesson.name) + '</div>' +
        '<span class="lesson-card-badge ' + (completions > 0 ? 'badge-done' : 'badge-new') + '">' +
          (completions > 0 ? 'Done x' + completions : 'New') +
        '</span>' +
      '</div>' +
      '<div class="lesson-card-chars">' +
        lesson.characters.map(c => '<span class="char-pill">' + c + '</span>').join('') +
      '</div>' +
      '<div class="lesson-card-reward">Complete for ' + nextReward + ' min TV time</div>';
    card.addEventListener('click', () => startLesson(lesson.id));
    els.lessonListLearner.appendChild(card);
  });
}

// ============================================
// PARENT DASHBOARD
// ============================================
function renderParentDashboard() {
  const lessons = Storage.getLessons();
  els.statLessons.textContent = lessons.length;
  els.statUnclaimed.textContent = Storage.getUnclaimedBalance() + ' min';
  els.statTotal.textContent = Storage.getTotalEarned() + ' min';

  els.lessonListParent.innerHTML = '';
  els.noLessonsParent.classList.toggle('hidden', lessons.length > 0);

  lessons.forEach(lesson => {
    const unclaimed = lesson.completions.filter(c => !c.claimed).length;
    const card = document.createElement('div');
    card.className = 'lesson-card';
    card.innerHTML =
      '<div class="lesson-card-header">' +
        '<div class="lesson-card-name">' + esc(lesson.name) + '</div>' +
        (unclaimed > 0
          ? '<span class="lesson-card-badge badge-new">' + unclaimed + ' unclaimed</span>'
          : '') +
      '</div>' +
      '<div class="lesson-card-chars">' +
        lesson.characters.map(c => '<span class="char-pill">' + c + '</span>').join('') +
      '</div>' +
      '<div class="lesson-card-stats">' +
        '<span>Completed: ' + lesson.completions.length + ' times</span>' +
      '</div>';
    card.addEventListener('click', () => showLessonReview(lesson.id));
    els.lessonListParent.appendChild(card);
  });
}

// ============================================
// CREATE / EDIT LESSON
// ============================================
function showCreateLesson(editId) {
  state.editingLessonId = editId || null;

  if (editId) {
    const lesson = Storage.getLesson(editId);
    els.lessonNameInput.value = lesson.name;
    els.lessonCharsInput.value = lesson.characters.join('');
    navigateTo('create-lesson', 'Edit Lesson');
  } else {
    els.lessonNameInput.value = '';
    els.lessonCharsInput.value = '';
    navigateTo('create-lesson', 'New Lesson');
  }
  els.lessonError.classList.add('hidden');
  validateLessonInput();
}

function extractCJK(text) {
  const chars = [];
  for (const ch of text) {
    if (CJK_REGEX.test(ch)) chars.push(ch);
  }
  return chars;
}

function validateLessonInput() {
  const name = els.lessonNameInput.value.trim();
  const chars = extractCJK(els.lessonCharsInput.value);
  const count = chars.length;

  els.lessonCharCount.textContent = count + ' / 10 characters';
  els.lessonCharCount.style.color = (count >= 1 && count <= 10) ? '#4CAF50' : '#888';

  els.lessonCharPreview.innerHTML = '';
  chars.forEach(ch => {
    const pill = document.createElement('span');
    pill.className = 'char-pill';
    pill.textContent = ch;
    els.lessonCharPreview.appendChild(pill);
  });

  const valid = name.length > 0 && count >= 1 && count <= 10;
  els.btnSaveLesson.disabled = !valid;
}

function saveLesson() {
  const name = els.lessonNameInput.value.trim();
  const chars = extractCJK(els.lessonCharsInput.value);

  if (!name || chars.length < 1 || chars.length > 10) return;

  if (state.editingLessonId) {
    Storage.updateLesson(state.editingLessonId, name, chars);
  } else {
    Storage.createLesson(name, chars);
  }

  state.editingLessonId = null;
  // Go back to parent dashboard
  navBack();
}

// ============================================
// LESSON REVIEW (Parent)
// ============================================
function showLessonReview(lessonId) {
  state.currentLessonId = lessonId;
  navigateTo('lesson-review', 'Lesson Review');
  renderLessonReview();
}

function renderLessonReview() {
  const lesson = Storage.getLesson(state.currentLessonId);
  if (!lesson) return;

  els.reviewName.textContent = lesson.name;
  els.reviewChars.innerHTML = lesson.characters
    .map(c => '<span class="char-pill">' + c + '</span>').join('');

  els.reviewCompletions.innerHTML = '';
  els.noCompletions.classList.toggle('hidden', lesson.completions.length > 0);

  lesson.completions.forEach((comp, i) => {
    const date = new Date(comp.date);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const item = document.createElement('div');
    item.className = 'completion-item' + (comp.claimed ? ' claimed' : '');
    item.innerHTML =
      '<div class="completion-info">' +
        '<div class="completion-date">' + dateStr + '</div>' +
        '<div class="completion-detail">Cycle ' + (i + 1) + ' &middot; ' + comp.totalMistakes + ' mistakes</div>' +
      '</div>' +
      '<div class="completion-reward">' +
        '<span class="reward-amount">' + comp.tvEarned + ' min</span>' +
        '<input type="checkbox" class="claim-checkbox" ' +
          (comp.claimed ? 'checked' : '') +
          ' title="Mark as claimed">' +
      '</div>';

    const checkbox = item.querySelector('.claim-checkbox');
    checkbox.addEventListener('change', () => {
      Storage.markClaimed(state.currentLessonId, comp.id, checkbox.checked);
      renderLessonReview();
    });

    els.reviewCompletions.appendChild(item);
  });
}

function editCurrentLesson() {
  showCreateLesson(state.currentLessonId);
}

function deleteCurrentLesson() {
  if (confirm('Delete this lesson and all its completion data?')) {
    Storage.deleteLesson(state.currentLessonId);
    state.currentLessonId = null;
    navBack();
  }
}

// ============================================
// CHANGE PIN
// ============================================
function saveNewPin() {
  const current = els.currentPinInput.value;
  const newPin = els.newPinInput.value;
  const confirm = els.confirmPinInput.value;
  const errEl = els.pinChangeError;

  if (current !== Storage.getPin()) {
    errEl.textContent = 'Current PIN is incorrect';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) {
    errEl.textContent = 'New PIN must be 4 digits';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPin !== confirm) {
    errEl.textContent = 'PINs do not match';
    errEl.classList.remove('hidden');
    return;
  }

  Storage.setPin(newPin);
  els.currentPinInput.value = '';
  els.newPinInput.value = '';
  els.confirmPinInput.value = '';
  errEl.classList.add('hidden');
  navBack();
}

// ============================================
// PRACTICE FLOW
// ============================================
async function startLesson(lessonId) {
  const lesson = Storage.getLesson(lessonId);
  if (!lesson) return;

  state.currentLessonId = lessonId;
  state.characters = lesson.characters.slice();
  state.currentCharIndex = 0;
  state.completedChars = new Set();
  state.score = 0;

  // Fetch dictionary data
  await fetchDictData(state.characters);

  navigateTo('practice', lesson.name);
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
  state.guidedTotal = GUIDED_ATTEMPTS;
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
      width: 100, height: 100, padding: 5,
      strokeColor: '#333', outlineColor: '#ccc',
      strokeAnimationSpeed: 1, delayBetweenStrokes: 300,
    });
  }

  createQuizWriter(char);
}

function createQuizWriter(char) {
  els.quizWriterTarget.innerHTML = '';
  const size = calcQuizSize();
  const guided = state.attemptNum <= state.guidedTotal;

  state.quizWriter = HanziWriter.create(els.quizWriterTarget, char, {
    width: size, height: size, padding: 15,
    strokeColor: '#555', outlineColor: '#ddd',
    drawingColor: '#4CAF50', drawingWidth: 8,
    showOutline: guided, showCharacter: false,
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
  const total = state.characters.length;
  els.scoreDisplay.textContent = state.score + ' / ' + total;
  els.charIndexDisplay.textContent = 'Character ' + (state.currentCharIndex + 1);

  const isGuided = state.attemptNum <= state.guidedTotal;
  if (isGuided) {
    els.attemptDisplay.textContent = 'Trace ' + state.attemptNum + '/' + state.guidedTotal;
    els.attemptDisplay.style.color = '#4a90d9';
  } else {
    els.attemptDisplay.textContent = 'Free trace!';
    els.attemptDisplay.style.color = '#e67e22';
  }
  // Show "Guided Trace" button only during free trace
  els.btnGuided.classList.toggle('hidden', isGuided);
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

  if (state.attemptNum <= state.guidedTotal) {
    state.attemptNum++;
    showSuccessFlash('Nice!', () => {
      state.isAnimating = false;
      updatePracticeUI();
      createQuizWriter(state.characters[state.currentCharIndex]);
    });
  } else {
    if (data.totalMistakes <= MAX_MISTAKES_UNGUIDED) {
      markCharacterComplete();
    } else {
      state.isAnimating = false;
      els.failDialog.classList.remove('hidden');
    }
  }
}

function markCharacterComplete() {
  state.completedChars.add(state.currentCharIndex);
  state.score++;
  const total = state.characters.length;

  showSuccessFlash('Correct!', () => {
    state.isAnimating = false;
    if (state.score === total) {
      completeLessonCycle();
    } else {
      initCharacter(nextIncompleteIndex());
    }
  });
}

function nextIncompleteIndex() {
  const total = state.characters.length;
  for (let i = 1; i <= total; i++) {
    const idx = (state.currentCharIndex + i) % total;
    if (!state.completedChars.has(idx)) return idx;
  }
  return 0;
}

function completeLessonCycle() {
  const lesson = Storage.getLesson(state.currentLessonId);
  const cycle = lesson.completions.length;
  const tvEarned = TV_REWARDS[Math.min(cycle, TV_REWARDS.length - 1)];

  Storage.addCompletion(state.currentLessonId, {
    cycle: cycle + 1,
    totalMistakes: 0, // could sum up per-char mistakes if tracked
    tvEarned: tvEarned,
    claimed: false,
  });

  // Show reward
  const balance = Storage.getUnclaimedBalance();
  els.tvTimeDisplay.textContent = 'You earned ' + tvEarned + ' minutes!';
  els.tvTimeTotal.textContent = 'Balance: ' + balance + ' minutes';

  destroyWriters();
  navigateTo('reward', 'Reward!');
  launchConfetti();
}

function retryGuided() {
  els.failDialog.classList.add('hidden');
  state.guidedTotal++;
  state.attemptNum = state.guidedTotal;
  updatePracticeUI();
  createQuizWriter(state.characters[state.currentCharIndex]);
}

function retryUnguided() {
  els.failDialog.classList.add('hidden');
  state.attemptNum = state.guidedTotal + 1;
  updatePracticeUI();
  createQuizWriter(state.characters[state.currentCharIndex]);
}

function switchToGuided() {
  if (state.isAnimating) return;
  state.guidedTotal++;
  state.attemptNum = state.guidedTotal;
  updatePracticeUI();
  createQuizWriter(state.characters[state.currentCharIndex]);
}

function restartCurrentTrace() {
  if (state.isAnimating) return;
  createQuizWriter(state.characters[state.currentCharIndex]);
}

function showAnimation() {
  if (state.isAnimating) return;
  state.isAnimating = true;
  state.refWriter.animateCharacter({
    onComplete: () => { state.isAnimating = false; },
  });
}

function destroyWriters() {
  if (state.refWriter) {
    els.refWriterTarget.innerHTML = '';
    state.refWriter = null;
  }
  els.quizWriterTarget.innerHTML = '';
  state.quizWriter = null;
}

// ============================================
// DICTIONARY & PINYIN
// ============================================
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
      const res = await fetch(CEDICT_URL + encodeURIComponent(ch) + '.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.dictCache[ch] = {
        pinyin: formatPinyin(data.pinyin || []),
        meaning: formatMeaning(data.definitions || {}),
      };
    } catch (e) {
      state.dictCache[ch] = { pinyin: '—', meaning: '—' };
    }
  });
  await Promise.all(promises);
}

function updateCharDetails() {
  const char = state.characters[state.currentCharIndex];
  const info = state.dictCache[char] || { pinyin: '', meaning: '' };
  els.pinyinDisplay.textContent = info.pinyin;
  els.meaningDisplay.textContent = info.meaning;
}

// ============================================
// SPEECH
// ============================================
let voicesLoaded = false;

function ensureVoicesLoaded() {
  return new Promise((resolve) => {
    const voices = speechSynthesis.getVoices();
    if (voices.length > 0) { voicesLoaded = true; resolve(voices); return; }
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
  if (!voicesLoaded) await ensureVoicesLoaded();
  const utterance = new SpeechSynthesisUtterance(char);
  utterance.lang = 'zh-CN';
  utterance.rate = 0.8;
  const voices = speechSynthesis.getVoices();
  const zhVoice = voices.find(v => v.lang.startsWith('zh'));
  if (zhVoice) utterance.voice = zhVoice;
  speechSynthesis.speak(utterance);
}

// ============================================
// UI UTILITIES
// ============================================
function flashFeedback(color) {
  const ov = els.feedbackOverlay;
  ov.classList.remove('hidden', 'flash-red', 'flash-green');
  void ov.offsetWidth;
  ov.classList.add('flash-' + color);
  setTimeout(() => { ov.classList.add('hidden'); ov.classList.remove('flash-red', 'flash-green'); }, 400);
}

function showSuccessFlash(text, cb) {
  const ov = els.successOverlay;
  ov.querySelector('.overlay-text').textContent = text;
  ov.classList.remove('hidden');
  setTimeout(() => { ov.classList.add('hidden'); if (cb) cb(); }, 1000);
}

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
  setTimeout(() => { container.innerHTML = ''; }, 4000);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
