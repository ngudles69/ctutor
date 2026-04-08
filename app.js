// ============================================
// SECTIONS PIPELINE
// ============================================
const SECTIONS = [
  {
    id: 'guided', name: 'Guided Trace', desc: 'Practice with stroke outlines',
    rounds: 3, showOutline: true, showRef: true,
    controls: ['restart', 'animate', 'skip'],
  },
  {
    id: 'free', name: 'Free Trace', desc: 'Write without outlines',
    rounds: 1, showOutline: false, showRef: true,
    controls: ['restart', 'guided', 'animate', 'skip'],
  },
  {
    id: 'tingxie', name: '\u542C\u5199', desc: 'Listen and write from memory',
    rounds: 1, showOutline: false, showRef: false,
    randomize: true, perCharScoring: true,
    controls: ['restart', 'skip'],
  },
];

// Revision sublessons are dynamically constructed; each tingxie failure creates
// one guided + one free sublesson, both 1 round, for the failed phrases.
const REVISION_GUIDED_BASE = {
  desc: 'Review wrong characters (guided)',
  rounds: 1, showOutline: true, showRef: true,
  controls: ['restart', 'animate', 'skip'],
};
const REVISION_FREE_BASE = {
  desc: 'Review wrong characters (free)',
  rounds: 1, showOutline: false, showRef: true,
  controls: ['restart', 'animate', 'skip'],
};

// ============================================
// CONSTANTS
// ============================================
const MAX_PHRASES = 20;
const MAX_MISTAKES_UNGUIDED = 2;
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const CEDICT_URL = 'https://cdn.jsdelivr.net/gh/krmanik/cedict-json/v2/';
const PHRASE_DELIM = /[,\uFF0C\s.\u3002\u3001;\uFF1B\n\r]+/;
const SECTION_SCORES = { guided: 20, free: 20, tingxie: 40, bonus: 20 };
const STICKER_POOL_SIZE = 1025;
const STICKER_BASE_URL = 'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/other/official-artwork/';
const STICKER_SPECIES_URL = 'https://pokeapi.co/api/v2/pokemon-species/';
const STICKER_NAMES_KEY = 'ctutor_sticker_names';
function stickerUrl(id) { return STICKER_BASE_URL + id + '.png'; }

let _stickerNamesCache = null;
function getStickerNamesCache() {
  if (_stickerNamesCache) return _stickerNamesCache;
  try { _stickerNamesCache = JSON.parse(localStorage.getItem(STICKER_NAMES_KEY) || '{}'); }
  catch (e) { _stickerNamesCache = {}; }
  return _stickerNamesCache;
}
function saveStickerName(id, name) {
  const cache = getStickerNamesCache();
  cache[id] = name;
  try { localStorage.setItem(STICKER_NAMES_KEY, JSON.stringify(cache)); } catch (e) {}
}
async function fetchStickerName(id) {
  const cache = getStickerNamesCache();
  if (cache[id]) return cache[id];
  try {
    const res = await fetch(STICKER_SPECIES_URL + id + '/');
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    // Prefer English; fall back to species lowercase name
    const en = (data.names || []).find(n => n.language && n.language.name === 'en');
    const name = en ? en.name : (data.name || '');
    if (name) saveStickerName(id, name);
    return name;
  } catch (e) {
    return null;
  }
}

// ============================================
// STORAGE LAYER
// ============================================
const Storage = {
  _data: null, _KEY: 'ctutor_data',
  _load() {
    if (this._data) return this._data;
    try {
      const raw = localStorage.getItem(this._KEY);
      this._data = raw ? JSON.parse(raw) : this._default();
      this._migrate();
    } catch (e) { this._data = this._default(); }
    return this._data;
  },
  _save() { try { localStorage.setItem(this._KEY, JSON.stringify(this._data)); } catch(e){} },
  _default() { return { pin: '1357', lessons: [], stickers: { owned: [], history: [], claims: {} } }; },
  _migrate() {
    this._data.lessons.forEach(l => {
      if (l.characters && !l.phrases) {
        l.phrases = l.characters.map(c => c);
        delete l.characters;
        this._save();
      }
    });
    if (!this._data.stickers) {
      this._data.stickers = { owned: [], history: [], claims: {} };
      this._save();
    }
    if (!this._data.stickers.claims) {
      this._data.stickers.claims = {};
      this._save();
    }
    // Legacy skipRequest stored as a plain string -> upgrade to object
    this._data.lessons.forEach(l => {
      if (typeof l.skipRequest === 'string') {
        l.skipRequest = { id: 'legacy', status: l.skipRequest, createdAt: 0 };
        this._save();
      }
    });
  },
  getPin() { return this._load().pin; },
  setPin(pin) { this._load().pin = pin; this._save(); },
  getLessons() { return this._load().lessons; },
  getLesson(id) { return this.getLessons().find(l => l.id === id); },
  createLesson(name, phrases) {
    const lesson = { id: 'l_' + Date.now(), name, phrases, createdAt: Date.now(), completions: [] };
    this._load().lessons.push(lesson); this._save(); return lesson;
  },
  updateLesson(id, name, phrases) {
    const l = this.getLesson(id); if (!l) return;
    l.name = name; l.phrases = phrases; this._save();
  },
  deleteLesson(id) { const d = this._load(); d.lessons = d.lessons.filter(l => l.id !== id); this._save(); },
  addCompletion(lessonId, comp) {
    const l = this.getLesson(lessonId); if (!l) return;
    comp.id = 'c_' + Date.now(); comp.date = Date.now();
    l.completions.push(comp); this._save(); return comp;
  },
  setCompletionNote(lessonId, compId, note) {
    const l = this.getLesson(lessonId); if (!l) return;
    const c = l.completions.find(x => x.id === compId);
    if (c) { c.note = note; this._save(); }
  },
  saveLessonProgress(lessonId, progress) {
    const l = this.getLesson(lessonId); if (!l) return;
    l.progress = progress;
    this._save();
  },
  getLessonProgress(lessonId) {
    const l = this.getLesson(lessonId); if (!l) return null;
    return l.progress || null;
  },
  clearLessonProgress(lessonId) {
    const l = this.getLesson(lessonId); if (!l) return;
    delete l.progress;
    this._save();
  },
  addAttemptStats(lessonId, stats) {
    const l = this.getLesson(lessonId); if (!l) return;
    if (!l.attempts) l.attempts = [];
    l.attempts.push(stats);
    this._save();
  },
  clearAttempts(lessonId) {
    const l = this.getLesson(lessonId); if (!l) return;
    delete l.attempts;
    this._save();
  },
  getStickerOwned() { return this._load().stickers.owned; },
  getStickerCount() { return this._load().stickers.owned.length; },
  hasSticker(id) { return this._load().stickers.owned.includes(id); },
  getStickerClaim(id) { return this._load().stickers.claims[id] || null; },
  getUnclaimedStickerCount() {
    const s = this._load().stickers;
    return s.owned.filter(id => !s.claims[id]).length;
  },
  getStickerEarnedDate(id) {
    const h = this._load().stickers.history;
    for (let i = 0; i < h.length; i++) if (h[i].id === id) return h[i].date;
    return null;
  },
  claimSticker(id, comment) {
    const s = this._load().stickers;
    s.claims[id] = { claimedAt: Date.now(), comment: comment || '' };
    this._save();
  },
  unclaimSticker(id) {
    const s = this._load().stickers;
    delete s.claims[id];
    this._save();
  },
  setStickerClaimComment(id, comment) {
    const s = this._load().stickers;
    if (s.claims[id]) { s.claims[id].comment = comment; this._save(); }
  },
  awardRandomSticker(lessonId, compId) {
    const data = this._load();
    const ownedSet = new Set(data.stickers.owned);
    let pickFrom;
    if (ownedSet.size < STICKER_POOL_SIZE) {
      // Random unowned
      pickFrom = [];
      for (let i = 1; i <= STICKER_POOL_SIZE; i++) if (!ownedSet.has(i)) pickFrom.push(i);
    } else {
      // Full collection — random duplicate
      pickFrom = [];
      for (let i = 1; i <= STICKER_POOL_SIZE; i++) pickFrom.push(i);
    }
    const id = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    const isNew = !ownedSet.has(id);
    if (isNew) data.stickers.owned.push(id);
    data.stickers.history.push({ id: id, lessonId: lessonId, compId: compId, date: Date.now() });
    this._save();
    return { id: id, isNew: isNew };
  },
  // Skip-permission requests (per lesson, single active per lesson)
  getSkipRequest(lessonId) {
    const l = this.getLesson(lessonId); return l ? (l.skipRequest || null) : null;
  },
  setSkipRequest(lessonId, value) {
    const l = this.getLesson(lessonId); if (!l) return;
    if (value) l.skipRequest = value;
    else delete l.skipRequest;
    this._save();
  },
  getActiveSkipRequests() {
    return this.getLessons().filter(l => l.skipRequest && (l.skipRequest.status === 'pending' || l.skipRequest.status === 'approved'));
  },
};

// ============================================
// STATE
// ============================================
const state = {
  mode: null, currentLessonId: null,
  // Practice
  phrases: [],
  activeSectionId: null,      // current section being practiced
  phraseOrder: [],             // indices into phrases[]
  phraseOrderIdx: 0,           // index into phraseOrder
  currentCharIdx: 0,           // char within current phrase
  roundNum: 1,
  guidedTotal: 3,
  isAnimating: false,
  charAttempts: 0,       // failed attempts on current char (for fail dialog)
  // Section menu scoring
  sectionScores: { guided: 0, free: 0, tingxie: 0, bonus: 0 },
  completedSections: [],       // array of completed section IDs (serializable)
  revisionAttempts: [],        // [{ phrases: [phraseIdx,...] }] — each tingxie failure adds one
  tingxieResults: {},          // { phraseIdx: [bool, bool, ...] }
  tingxieCharResults: [],      // boolean per char for current phrase
  // Per-attempt stats (for parent review)
  attemptStats: null,          // { sectionId, sectionName, totalChars: 0, totalMistakes: 0 }
  // Writers
  refWriter: null, quizWriter: null, phraseWriters: [],
  dictCache: {},
  // Edit
  editingLessonId: null,
  navStack: [],
  // Stickers
  stickerFilter: 'gallery',
  stickerDetailId: null,
};

// ============================================
// DOM
// ============================================
const $ = id => document.getElementById(id);
const els = {
  topBar:$('top-bar'), topTitle:$('top-title'), btnBack:$('btn-back'), btnHome:$('btn-home'), btnModeSwitch:$('btn-mode-switch'),
  btnEnterLearner:$('btn-enter-learner'), btnEnterParent:$('btn-enter-parent'),
  btnExportData:$('btn-export-data'), btnImportData:$('btn-import-data'), btnShareData:$('btn-share-data'), btnTestSpeech:$('btn-test-speech'), importFileInput:$('import-file-input'),
  importDialog:$('import-dialog'), importSummary:$('import-summary'),
  btnImportMerge:$('btn-import-merge'), btnImportReplace:$('btn-import-replace'),
  btnImportShowMore:$('btn-import-show-more'), btnImportMoreOptions:$('import-more-options'),
  btnImportCancel:$('btn-import-cancel'),
  pinInput:$('pin-input'), pinError:$('pin-error'), btnPinSubmit:$('btn-pin-submit'), btnPinCancel:$('btn-pin-cancel'),
  stickersCard:$('stickers-card'), stickersCardParent:$('stickers-card-parent'), stickersAmount:$('stickers-amount'),
  stickersHeader:$('stickers-header'), stickersGrid:$('stickers-grid'),
  stickersFilter:$('stickers-filter'), btnFilterGallery:$('btn-filter-gallery'), btnFilterAll:$('btn-filter-all'), btnFilterUnclaimed:$('btn-filter-unclaimed'),
  stickerDetailDialog:$('sticker-detail-dialog'), stickerDetailImg:$('sticker-detail-img'),
  stickerDetailName:$('sticker-detail-name'),
  stickerDetailEarned:$('sticker-detail-earned'), stickerDetailClaimStatus:$('sticker-detail-claim-status'),
  stickerDetailComment:$('sticker-detail-comment'),
  btnStickerClaim:$('btn-sticker-claim'), btnStickerUnclaim:$('btn-sticker-unclaim'),
  btnStickerDetailClose:$('btn-sticker-detail-close'),
  stickerReveal:$('sticker-reveal'), stickerRevealImg:$('sticker-reveal-img'), stickerRevealProgress:$('sticker-reveal-progress'),
  lessonListLearner:$('lesson-list-learner'), noLessonsLearner:$('no-lessons-learner'),
  statLessons:$('stat-lessons'), statCompletions:$('stat-completions'), statStickers:$('stat-stickers'),
  lessonListParent:$('lesson-list-parent'), noLessonsParent:$('no-lessons-parent'),
  skipRequestsSection:$('skip-requests-section'), skipRequestsList:$('skip-requests-list'),
  btnAddLesson:$('btn-add-lesson'), btnChangePin:$('btn-change-pin'),
  lessonNameInput:$('lesson-name-input'), phraseInputsContainer:$('phrase-inputs-container'),
  btnAddPhrase:$('btn-add-phrase'),
  lessonPhraseCount:$('lesson-phrase-count'), lessonPhrasePreview:$('lesson-phrase-preview'),
  lessonError:$('lesson-error'), btnSaveLesson:$('btn-save-lesson'), btnCancelLesson:$('btn-cancel-lesson'),
  reviewName:$('review-name'), reviewPhrases:$('review-phrases'),
  reviewAttempts:$('review-attempts'), noAttempts:$('no-attempts'),
  reviewCompletions:$('review-completions'), noCompletions:$('no-completions'),
  btnEditLesson:$('btn-edit-lesson'), btnDeleteLesson:$('btn-delete-lesson'),
  currentPinInput:$('current-pin-input'), newPinInput:$('new-pin-input'), confirmPinInput:$('confirm-pin-input'),
  pinChangeError:$('pin-change-error'), btnSavePin:$('btn-save-pin'), btnCancelPin:$('btn-cancel-pin'),
  // Section menu
  sectionMenuScore:$('section-menu-score'), sectionMenuList:$('section-menu-list'),
  btnCompleteLesson:$('btn-complete-lesson'), confettiContainerMenu:$('confetti-container-menu'),
  // Practice
  sectionTabs:$('section-tabs'), phraseCharsDisplay:$('phrase-chars-display'),
  phraseProgress:$('phrase-progress'), practiceScore:$('practice-score'),
  refArea:$('ref-area'), tingxieArea:$('tingxie-area'), tingxieCharsDisplay:$('tingxie-chars-display'), btnSpeakPhrase:$('btn-speak-phrase'),
  refCharContainer:$('ref-char-container'), refWriterTarget:$('ref-writer-target'),
  refInfo:$('ref-info'), pinyinDisplay:$('pinyin-display'), meaningDisplay:$('meaning-display'),
  btnSpeak:$('btn-speak'), progressInfo:$('progress-info'),
  attemptDisplay:$('attempt-display'),
  quizWriterTarget:$('quiz-writer-target'), feedbackOverlay:$('feedback-overlay'),
  practiceControls:$('practice-controls'),
  btnRestart:$('btn-restart'), btnGuided:$('btn-guided'), btnAnimate:$('btn-animate'), btnSkip:$('btn-skip'),
  failDialog:$('fail-dialog'), btnRetryGuided:$('btn-retry-guided'), btnRetryFree:$('btn-retry-free'), btnFailSkip:$('btn-fail-skip'),
  successOverlay:$('success-overlay'),
  // Reward
  scoreSummary:$('score-summary'),
  confettiContainer:$('confetti-container'), btnBackToLessons:$('btn-back-to-lessons'),
};

// ============================================
// INIT
// ============================================
function init() {
  els.btnEnterLearner.addEventListener('click', () => enterLearnerMode());
  els.btnEnterParent.addEventListener('click', () => showPinEntry('parent'));
  els.btnExportData.addEventListener('click', exportData);
  els.btnImportData.addEventListener('click', () => els.importFileInput.click());
  els.importFileInput.addEventListener('change', importData);
  els.btnShareData.addEventListener('click', shareData);
  els.btnTestSpeech.addEventListener('click', testSpeech);
  els.btnImportMerge.addEventListener('click', () => doImport('merge'));
  els.btnImportReplace.addEventListener('click', () => doImport('replace'));
  els.btnImportShowMore.addEventListener('click', () => {
    els.btnImportMoreOptions.classList.remove('hidden');
    els.btnImportShowMore.classList.add('hidden');
  });
  els.btnImportCancel.addEventListener('click', closeImportDialog);
  checkUrlImport();
  els.btnBack.addEventListener('click', navBack);
  els.btnHome.addEventListener('click', goHome);
  els.stickersCard.addEventListener('click', () => navigateTo('stickers', 'My Stickers'));
  els.stickersCardParent.addEventListener('click', () => navigateTo('stickers', 'Sticker Book'));
  els.btnFilterGallery.addEventListener('click', () => setStickerFilter('gallery'));
  els.btnFilterAll.addEventListener('click', () => setStickerFilter('all'));
  els.btnFilterUnclaimed.addEventListener('click', () => setStickerFilter('unclaimed'));
  els.stickerDetailDialog.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeStickerDetail();
  });
  els.btnStickerClaim.addEventListener('click', confirmClaimSticker);
  els.btnStickerUnclaim.addEventListener('click', confirmUnclaimSticker);
  els.btnStickerDetailClose.addEventListener('click', closeStickerDetail);
  els.stickerDetailComment.addEventListener('input', function() {
    if (state.stickerDetailId != null && Storage.getStickerClaim(state.stickerDetailId)) {
      Storage.setStickerClaimComment(state.stickerDetailId, this.value);
    }
  });
  els.btnModeSwitch.addEventListener('click', handleModeSwitch);
  els.btnPinSubmit.addEventListener('click', submitPin);
  els.btnPinCancel.addEventListener('click', navBack);
  els.pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitPin(); });
  els.btnAddLesson.addEventListener('click', () => showCreateLesson());
  els.btnChangePin.addEventListener('click', () => navigateTo('change-pin', 'Change PIN'));
  els.lessonNameInput.addEventListener('input', validateLessonInput);
  els.btnAddPhrase.addEventListener('click', () => addPhraseInput(''));
  els.btnSaveLesson.addEventListener('click', saveLesson);
  els.btnCancelLesson.addEventListener('click', navBack);
  els.btnEditLesson.addEventListener('click', editCurrentLesson);
  els.btnDeleteLesson.addEventListener('click', deleteCurrentLesson);
  els.btnSavePin.addEventListener('click', saveNewPin);
  els.btnCancelPin.addEventListener('click', navBack);
  els.btnRestart.addEventListener('click', restartCurrentTrace);
  els.btnGuided.addEventListener('click', switchToGuided);
  els.btnAnimate.addEventListener('click', showAnimation);
  els.btnSkip.addEventListener('click', skipCharacter);
  els.btnSpeak.addEventListener('click', () => speakText(getCurrentPhrase()));
  els.btnSpeakPhrase.addEventListener('click', () => speakText(getCurrentPhrase()));
  els.btnRetryGuided.addEventListener('click', retryWithGuided);
  els.btnRetryFree.addEventListener('click', retryFree);
  els.btnFailSkip.addEventListener('click', () => { els.failDialog.classList.add('hidden'); skipCharacter(); });
  els.btnBackToLessons.addEventListener('click', () => navigateTo('learner', 'Lessons'));
  els.btnCompleteLesson.addEventListener('click', completeLesson);
  document.addEventListener('dblclick', e => e.preventDefault());
}
document.addEventListener('DOMContentLoaded', init);

// ============================================
// NAVIGATION
// ============================================
function navigateTo(screenId, title, opts) {
  opts = opts || {};
  // Close any open sticker detail when navigating away
  if (els.stickerDetailDialog && !els.stickerDetailDialog.classList.contains('hidden')) {
    closeStickerDetail();
  }
  document.querySelectorAll('.screen').forEach(s => { s.classList.add('hidden'); s.classList.remove('active'); });
  const showTop = screenId !== 'home';
  els.topBar.classList.toggle('hidden', !showTop);
  const target = $('screen-' + screenId);
  target.classList.remove('hidden'); target.classList.add('active');
  target.classList.toggle('has-topbar', showTop);
  if (showTop) {
    els.topTitle.textContent = title || '';
    const isDashboard = ['learner','parent'].includes(screenId);
    els.btnBack.classList.toggle('hidden', isDashboard);
    els.btnHome.classList.toggle('hidden', !isDashboard);
  }
  if (!opts.replace) state.navStack.push({ screenId, title });
  if (screenId === 'learner') renderLearnerDashboard();
  if (screenId === 'parent') renderParentDashboard();
  if (screenId === 'section-menu') renderSectionMenu();
  if (screenId === 'stickers') renderStickerBook();
}
function navBack() {
  if (state.navStack.length > 1) { state.navStack.pop(); const p = state.navStack[state.navStack.length-1]; navigateTo(p.screenId, p.title, {replace:true}); }
  else navigateTo('home');
}
function handleModeSwitch() { state.mode === 'learner' ? showPinEntry('parent') : enterLearnerMode(); }
function goHome() { state.mode=null; state.navStack=[]; navigateTo('home'); }
function enterLearnerMode() { state.mode='learner'; state.navStack=[]; navigateTo('learner','Lessons'); }
function enterParentMode() { state.mode='parent'; state.navStack=[]; navigateTo('parent','Parent / Teacher'); }

// ============================================
// PIN
// ============================================
let pinTarget = null;
function showPinEntry(t) { pinTarget=t; els.pinInput.value=''; els.pinError.classList.add('hidden'); navigateTo('pin','Enter PIN'); setTimeout(()=>els.pinInput.focus(),100); }
function submitPin() {
  if (els.pinInput.value === Storage.getPin()) { els.pinError.classList.add('hidden'); if (pinTarget==='parent') enterParentMode(); }
  else { els.pinError.textContent='Incorrect PIN'; els.pinError.classList.remove('hidden'); els.pinInput.value=''; els.pinInput.focus(); }
}

// ============================================
// LEARNER DASHBOARD
// ============================================
function renderLearnerDashboard() {
  els.stickersAmount.textContent = Storage.getStickerCount();
  const unclaimed = Storage.getUnclaimedStickerCount();
  els.stickersCard.classList.toggle('has-unclaimed', unclaimed > 0);
  els.stickersCard.dataset.unclaimed = unclaimed;
  const lessons = Storage.getLessons();
  els.lessonListLearner.innerHTML = '';
  els.noLessonsLearner.classList.toggle('hidden', lessons.length > 0);
  lessons.forEach(lesson => {
    const card = document.createElement('div'); card.className = 'lesson-card';
    const skipReq = lesson.skipRequest || null;
    let skipBtnHtml = '';
    if (skipReq && skipReq.status === 'approved') {
      skipBtnHtml = '<button class="lesson-skip-btn approved" data-skip="approved">\u2728 Skip ready! Tap lesson to use</button>';
    } else if (skipReq && skipReq.status === 'pending') {
      skipBtnHtml = '<button class="lesson-skip-btn pending" data-skip="resend">Tap to resend skip request</button>';
    } else {
      skipBtnHtml = '<button class="lesson-skip-btn" data-skip="ask">Ask to skip to \u542C\u5199</button>';
    }
    card.innerHTML =
      '<div class="lesson-card-header"><div class="lesson-card-name">' + esc(lesson.name) + '</div>' +
      '<span class="lesson-card-badge ' + (lesson.completions.length ? 'badge-done' : 'badge-new') + '">' +
      (lesson.completions.length ? 'Done x' + lesson.completions.length : 'New') + '</span></div>' +
      '<div class="phrase-preview">' + lesson.phrases.map(p => '<span class="phrase-pill">' + esc(p) + '</span>').join('') + '</div>' +
      '<div class="lesson-card-reward">Complete to earn a sticker!</div>' +
      skipBtnHtml;
    const skipBtn = card.querySelector('.lesson-skip-btn');
    skipBtn.addEventListener('click', e => {
      e.stopPropagation();
      const action = skipBtn.dataset.skip;
      if (action === 'ask' || action === 'resend') shareSkipRequest(lesson.id);
    });
    card.addEventListener('click', () => startLesson(lesson.id));
    els.lessonListLearner.appendChild(card);
  });
}

async function shareSkipRequest(lessonId) {
  const lesson = Storage.getLesson(lessonId); if (!lesson) return;
  // One active request per lesson. Reuse existing pending id; don't
  // create a new one if already approved (consume it first).
  const existing = lesson.skipRequest;
  if (existing && existing.status === 'approved') {
    alert('You already have an approved skip for this lesson. Tap the lesson to use it.');
    return;
  }
  let rid, createdAt;
  if (existing && existing.status === 'pending') {
    rid = existing.id;
    createdAt = existing.createdAt;
  } else {
    rid = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    createdAt = Date.now();
    Storage.setSkipRequest(lessonId, { id: rid, status: 'pending', createdAt: createdAt });
    renderLearnerDashboard();
  }

  const payload = { t: 'sr', rid: rid, lid: lessonId, ln: lesson.name, ph: lesson.phrases, at: createdAt };
  const encoded = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
  const url = location.origin + location.pathname + '?sr=' + encoded;
  const text = 'Chinese Tutor skip request for "' + lesson.name + '": ' + url;

  if (navigator.share) {
    try { await navigator.share({ text: text }); return; }
    catch (e) { if (e.name !== 'AbortError') console.warn('share failed:', e); }
  }
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); alert('Skip request link copied to clipboard'); return; }
    catch (e) { /* fall through */ }
  }
  alert('Could not share. Link: ' + url);
}

async function shareSkipApproval(lessonId) {
  const lesson = Storage.getLesson(lessonId); if (!lesson) return;
  const req = lesson.skipRequest;
  if (!req || !req.id) { alert('No pending request to approve'); return; }

  // Mark approved locally so banner clears
  Storage.setSkipRequest(lessonId, { id: req.id, status: 'approved', createdAt: req.createdAt, approvedAt: Date.now() });
  renderParentDashboard();

  const payload = { t: 'sa', rid: req.id, lid: lessonId, ln: lesson.name, ph: lesson.phrases, at: Date.now() };
  const encoded = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
  const url = location.origin + location.pathname + '?sa=' + encoded;
  const text = 'Chinese Tutor skip approved for "' + lesson.name + '": ' + url;

  if (navigator.share) {
    try { await navigator.share({ text: text }); return; }
    catch (e) { if (e.name !== 'AbortError') console.warn('share failed:', e); }
  }
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); alert('Approval link copied to clipboard'); return; }
    catch (e) { /* fall through */ }
  }
  alert('Could not share. Link: ' + url);
}

function findLessonByIdentity(lessonId, name, phrases) {
  let l = Storage.getLesson(lessonId);
  if (l) return l;
  const key = lessonKey({ name: name, phrases: phrases });
  return Storage.getLessons().find(x => lessonKey(x) === key) || null;
}

function ingestSkipRequest(payload) {
  if (!payload || !payload.rid || !payload.ln) {
    alert('Invalid skip request link.');
    return;
  }
  const local = findLessonByIdentity(payload.lid, payload.ln, payload.ph || []);
  if (!local) {
    alert('Skip request received for "' + payload.ln + '" but no matching lesson exists on this device. Import the lesson first.');
    return;
  }
  // Avoid clobbering an already-approved request with the same id
  const existing = local.skipRequest;
  if (existing && existing.id === payload.rid && existing.status === 'approved') {
    alert('This skip request was already approved.');
    return;
  }
  Storage.setSkipRequest(local.id, { id: payload.rid, status: 'pending', createdAt: payload.at || Date.now() });
  alert('Skip request received for: ' + local.name + '\nOpen Parent mode to approve.');
}

function ingestSkipApproval(payload) {
  if (!payload || !payload.rid || !payload.ln) {
    alert('Invalid skip approval link.');
    return;
  }
  const local = findLessonByIdentity(payload.lid, payload.ln, payload.ph || []);
  if (!local) {
    alert('Skip approval received for "' + payload.ln + '" but no matching lesson on this device.');
    return;
  }
  const req = local.skipRequest;
  if (!req || req.id !== payload.rid) {
    alert('Skip approval received for "' + local.name + '" but it does not match a pending request on this device.');
    return;
  }
  Storage.setSkipRequest(local.id, { id: req.id, status: 'approved', createdAt: req.createdAt, approvedAt: payload.at || Date.now() });
  alert('Skip approved for: ' + local.name + '!\nTap the lesson on the Learner page to use it.');
}

function renderSkipRequests() {
  const active = Storage.getActiveSkipRequests();
  els.skipRequestsSection.classList.toggle('hidden', active.length === 0);
  els.skipRequestsList.innerHTML = '';
  active.forEach(lesson => {
    const req = lesson.skipRequest;
    const isApproved = req.status === 'approved';
    const item = document.createElement('div');
    item.className = 'skip-request-item' + (isApproved ? ' approved' : '');
    const desc = isApproved
      ? 'Approved \u00b7 send the link to the learner'
      : 'Skip Guided + Free, go to \u542C\u5199';
    const actionsHtml = isApproved
      ? '<button class="btn-resend">Resend</button>' +
        '<button class="btn-dismiss">Done</button>'
      : '<button class="btn-approve">Approve</button>' +
        '<button class="btn-deny">Deny</button>';
    item.innerHTML =
      '<div class="skip-request-info">' +
      '<div class="skip-request-name">' + esc(lesson.name) + '</div>' +
      '<div class="skip-request-desc">' + desc + '</div>' +
      '</div>' +
      '<div class="skip-request-actions">' + actionsHtml + '</div>';
    if (isApproved) {
      item.querySelector('.btn-resend').addEventListener('click', () => shareSkipApproval(lesson.id));
      item.querySelector('.btn-dismiss').addEventListener('click', () => {
        Storage.setSkipRequest(lesson.id, null);
        renderParentDashboard();
      });
    } else {
      item.querySelector('.btn-approve').addEventListener('click', () => shareSkipApproval(lesson.id));
      item.querySelector('.btn-deny').addEventListener('click', () => {
        Storage.setSkipRequest(lesson.id, null);
        renderParentDashboard();
      });
    }
    els.skipRequestsList.appendChild(item);
  });
}

// ============================================
// STICKER BOOK
// ============================================
function renderStickerBook() {
  const owned = Storage.getStickerOwned();
  const ownedSet = new Set(owned);
  const unclaimedCount = Storage.getUnclaimedStickerCount();
  const filter = state.stickerFilter;

  // Header
  let headerText = owned.length + ' / ' + STICKER_POOL_SIZE + ' collected';
  if (owned.length > 0) headerText += ' \u00b7 ' + unclaimedCount + ' unclaimed';
  els.stickersHeader.textContent = headerText;

  // Filter row visible for both modes
  els.stickersFilter.classList.remove('hidden');

  const grid = els.stickersGrid;
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();

  if (filter === 'gallery') {
    // Full grid: all 1..N tiles, locked or owned
    for (let i = 1; i <= STICKER_POOL_SIZE; i++) {
      const isOwned = ownedSet.has(i);
      const isClaimed = isOwned && !!Storage.getStickerClaim(i);
      frag.appendChild(makeStickerTile(i, isOwned, isClaimed));
    }
  } else if (filter === 'all') {
    // Only owned, sorted by ID
    const sortedOwned = owned.slice().sort((a, b) => a - b);
    sortedOwned.forEach(id => {
      const isClaimed = !!Storage.getStickerClaim(id);
      frag.appendChild(makeStickerTile(id, true, isClaimed));
    });
    if (sortedOwned.length === 0) frag.appendChild(emptyMsg('No stickers earned yet.'));
  } else if (filter === 'unclaimed') {
    // Only owned-unclaimed
    const sortedOwned = owned.slice().sort((a, b) => a - b);
    let count = 0;
    sortedOwned.forEach(id => {
      if (!Storage.getStickerClaim(id)) {
        frag.appendChild(makeStickerTile(id, true, false));
        count++;
      }
    });
    if (count === 0) frag.appendChild(emptyMsg('No unclaimed stickers.'));
  }
  grid.appendChild(frag);
}

function emptyMsg(text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.style.gridColumn = '1 / -1';
  div.textContent = text;
  return div;
}

function makeStickerTile(id, isOwned, isClaimed) {
  const tile = document.createElement('div');
  if (isOwned) {
    tile.className = 'sticker-tile owned tappable' + (isClaimed ? ' claimed' : ' unclaimed');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = stickerUrl(id);
    img.alt = '';
    tile.appendChild(img);
    tile.addEventListener('click', () => openStickerDetail(id));
  } else {
    tile.className = 'sticker-tile locked';
  }
  return tile;
}

function setStickerFilter(filter) {
  state.stickerFilter = filter;
  els.btnFilterGallery.classList.toggle('active', filter === 'gallery');
  els.btnFilterAll.classList.toggle('active', filter === 'all');
  els.btnFilterUnclaimed.classList.toggle('active', filter === 'unclaimed');
  renderStickerBook();
}

function openStickerDetail(id) {
  state.stickerDetailId = id;
  const isParent = state.mode === 'parent';
  els.stickerDetailImg.src = stickerUrl(id);
  // Name: show cached immediately if any, otherwise fetch
  const cachedName = getStickerNamesCache()[id];
  els.stickerDetailName.textContent = cachedName || '\u2026';
  if (!cachedName) {
    fetchStickerName(id).then(name => {
      if (state.stickerDetailId === id && name) {
        els.stickerDetailName.textContent = name;
      }
    });
  }
  const earned = Storage.getStickerEarnedDate(id);
  els.stickerDetailEarned.textContent = earned
    ? 'Earned: ' + new Date(earned).toLocaleString()
    : '';
  const claim = Storage.getStickerClaim(id);
  // Comment textarea editable only for parent
  els.stickerDetailComment.readOnly = !isParent;
  if (claim) {
    els.stickerDetailClaimStatus.textContent = 'Claimed: ' + new Date(claim.claimedAt).toLocaleString();
    els.stickerDetailComment.value = claim.comment || '';
    // Show comment area only if there's content (learner) or always (parent)
    els.stickerDetailComment.classList.toggle('hidden', !isParent && !claim.comment);
    els.btnStickerClaim.classList.add('hidden');
    els.btnStickerUnclaim.classList.toggle('hidden', !isParent);
  } else {
    els.stickerDetailClaimStatus.textContent = 'Not yet claimed';
    els.stickerDetailComment.value = '';
    // Learner: hide empty comment area; Parent: keep visible for typing
    els.stickerDetailComment.classList.toggle('hidden', !isParent);
    els.btnStickerClaim.classList.toggle('hidden', !isParent);
    els.btnStickerUnclaim.classList.add('hidden');
  }
  els.stickerDetailDialog.classList.remove('hidden');
}

function closeStickerDetail() {
  els.stickerDetailDialog.classList.add('hidden');
  state.stickerDetailId = null;
}

function confirmClaimSticker() {
  if (state.stickerDetailId == null) return;
  Storage.claimSticker(state.stickerDetailId, els.stickerDetailComment.value);
  closeStickerDetail();
  renderStickerBook();
  if (state.mode === 'parent') renderParentDashboard();
}

function confirmUnclaimSticker() {
  if (state.stickerDetailId == null) return;
  Storage.unclaimSticker(state.stickerDetailId);
  closeStickerDetail();
  renderStickerBook();
  if (state.mode === 'parent') renderParentDashboard();
}

// ============================================
// PARENT DASHBOARD
// ============================================
function renderParentDashboard() {
  const lessons = Storage.getLessons();
  const totalCompletions = lessons.reduce((s, l) => s + l.completions.length, 0);
  const unclaimed = Storage.getUnclaimedStickerCount();
  els.statLessons.textContent = lessons.length;
  els.statCompletions.textContent = totalCompletions;
  els.statStickers.textContent = Storage.getStickerCount();
  els.stickersCardParent.classList.toggle('has-unclaimed', unclaimed > 0);
  els.stickersCardParent.dataset.unclaimed = unclaimed;
  renderSkipRequests();
  els.lessonListParent.innerHTML = '';
  els.noLessonsParent.classList.toggle('hidden', lessons.length > 0);
  lessons.forEach(lesson => {
    const card = document.createElement('div'); card.className = 'lesson-card';
    card.innerHTML =
      '<div class="lesson-card-header"><div class="lesson-card-name">' + esc(lesson.name) + '</div></div>' +
      '<div class="phrase-preview">' + lesson.phrases.map(p => '<span class="phrase-pill">' + esc(p) + '</span>').join('') + '</div>' +
      '<div class="lesson-card-stats"><span>Completed: ' + lesson.completions.length + ' times</span></div>';
    card.addEventListener('click', () => showLessonReview(lesson.id));
    els.lessonListParent.appendChild(card);
  });
}

// ============================================
// CREATE / EDIT LESSON (individual phrase inputs)
// ============================================
function parsePhrases(text) {
  return text.split(PHRASE_DELIM).map(s => {
    let p = ''; for (const ch of s) { if (CJK_REGEX.test(ch)) p += ch; }
    return p;
  }).filter(p => p.length > 0);
}

function extractCJK(text) {
  let p = ''; for (const ch of text) { if (CJK_REGEX.test(ch)) p += ch; }
  return p;
}

function addPhraseInput(value) {
  const count = els.phraseInputsContainer.querySelectorAll('.phrase-input-row').length;
  if (count >= MAX_PHRASES) return;
  const row = document.createElement('div');
  row.className = 'phrase-input-row';
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'phrase-field';
  input.placeholder = 'Type a phrase'; input.lang = 'zh'; input.autocomplete = 'off';
  input.value = value || '';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn-remove-phrase'; btn.textContent = '\u00d7';
  btn.addEventListener('click', () => removePhraseInput(row));
  input.addEventListener('input', () => handlePhraseFieldInput(input));
  row.appendChild(input); row.appendChild(btn);
  els.phraseInputsContainer.appendChild(row);
  validateLessonInput();
  return input;
}

function removePhraseInput(row) {
  const rows = els.phraseInputsContainer.querySelectorAll('.phrase-input-row');
  if (rows.length <= 1) return;
  row.remove();
  validateLessonInput();
}

function handlePhraseFieldInput(input) {
  const val = input.value;
  // Check for delimiters — auto-split
  if (PHRASE_DELIM.test(val)) {
    const parts = parsePhrases(val);
    if (parts.length > 1) {
      input.value = parts[0];
      for (let i = 1; i < parts.length; i++) {
        const newInput = addPhraseInput(parts[i]);
        if (!newInput) break; // MAX_PHRASES reached
      }
    } else if (parts.length === 1) {
      input.value = parts[0];
    } else {
      input.value = '';
    }
  }
  validateLessonInput();
}

function getPhraseFieldValues() {
  const fields = els.phraseInputsContainer.querySelectorAll('.phrase-field');
  const phrases = [];
  fields.forEach(f => {
    const cjk = extractCJK(f.value);
    if (cjk.length > 0) phrases.push(cjk);
  });
  return phrases;
}

function showCreateLesson(editId) {
  state.editingLessonId = editId || null;
  els.phraseInputsContainer.innerHTML = '';
  if (editId) {
    const l = Storage.getLesson(editId);
    els.lessonNameInput.value = l.name;
    l.phrases.forEach(p => addPhraseInput(p));
    navigateTo('create-lesson', 'Edit Lesson');
  } else {
    els.lessonNameInput.value = '';
    addPhraseInput('');
    navigateTo('create-lesson', 'New Lesson');
  }
  els.lessonError.classList.add('hidden');
  validateLessonInput();
}

function validateLessonInput() {
  const name = els.lessonNameInput.value.trim();
  const phrases = getPhraseFieldValues();
  els.lessonPhraseCount.textContent = phrases.length + ' / ' + MAX_PHRASES + ' phrases';
  els.lessonPhraseCount.style.color = (phrases.length >= 1 && phrases.length <= MAX_PHRASES) ? '#4CAF50' : '#888';
  els.lessonPhrasePreview.innerHTML = '';
  phrases.forEach(p => {
    const pill = document.createElement('span'); pill.className = 'phrase-pill'; pill.textContent = p;
    els.lessonPhrasePreview.appendChild(pill);
  });
  // Hide add button at max
  els.btnAddPhrase.style.display = (els.phraseInputsContainer.querySelectorAll('.phrase-input-row').length >= MAX_PHRASES) ? 'none' : '';
  els.btnSaveLesson.disabled = !(name.length > 0 && phrases.length >= 1 && phrases.length <= MAX_PHRASES);
}

function saveLesson() {
  const name = els.lessonNameInput.value.trim();
  const phrases = getPhraseFieldValues();
  if (!name || phrases.length < 1 || phrases.length > MAX_PHRASES) return;
  if (state.editingLessonId) Storage.updateLesson(state.editingLessonId, name, phrases);
  else Storage.createLesson(name, phrases);
  state.editingLessonId = null; navBack();
}

// ============================================
// LESSON REVIEW
// ============================================
function showLessonReview(lessonId) {
  state.currentLessonId = lessonId;
  navigateTo('lesson-review', 'Lesson Review');
  renderLessonReview();
}
function renderLessonReview() {
  const l = Storage.getLesson(state.currentLessonId); if (!l) return;
  els.reviewName.textContent = l.name;
  els.reviewPhrases.innerHTML = l.phrases.map(p => '<span class="phrase-pill">' + esc(p) + '</span>').join('');

  // Practice attempts
  els.reviewAttempts.innerHTML = '';
  const attempts = l.attempts || [];
  els.noAttempts.classList.toggle('hidden', attempts.length > 0);
  // Show newest first
  attempts.slice().reverse().forEach(att => {
    const d = new Date(att.timestamp);
    const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    const skipped = att.skipped || 0;
    const mistakes = att.totalMistakes || 0;
    const chars = att.totalChars || 0;
    const status = (mistakes === 0 && skipped === 0) ? 'ok' : 'miss';
    const item = document.createElement('div');
    item.className = 'attempt-item';
    item.innerHTML =
      '<div><div class="attempt-name">' + esc(att.sectionName) + '</div>' +
      '<div class="attempt-meta">' + dateStr + '</div></div>' +
      '<div class="attempt-stats">' + chars + ' chars &middot; ' +
      '<span class="' + status + '">' + mistakes + ' miss' + (skipped ? ' &middot; ' + skipped + ' skip' : '') + '</span></div>';
    els.reviewAttempts.appendChild(item);
  });

  els.reviewCompletions.innerHTML = '';
  els.noCompletions.classList.toggle('hidden', l.completions.length > 0);
  l.completions.forEach((comp) => {
    const d = new Date(comp.date);
    const item = document.createElement('div');
    item.className = 'completion-item';
    item.innerHTML =
      '<div class="completion-row">' +
      '<div class="completion-info"><div class="completion-date">' + d.toLocaleDateString() + '</div>' +
      '<div class="completion-detail">Score: ' + (comp.score||0) + '/100</div></div>' +
      '</div>' +
      '<input type="text" class="completion-note-input" placeholder="Add a note...">';
    const noteInput = item.querySelector('.completion-note-input');
    noteInput.value = comp.note || '';
    noteInput.addEventListener('input', function() {
      Storage.setCompletionNote(state.currentLessonId, comp.id, this.value);
    });
    els.reviewCompletions.appendChild(item);
  });
}
function editCurrentLesson() { showCreateLesson(state.currentLessonId); }
function deleteCurrentLesson() { if(confirm('Delete this lesson?')){ Storage.deleteLesson(state.currentLessonId); navBack(); } }

// ============================================
// CHANGE PIN
// ============================================
function saveNewPin() {
  const cur=els.currentPinInput.value, np=els.newPinInput.value, cf=els.confirmPinInput.value, e=els.pinChangeError;
  if (cur!==Storage.getPin()) { e.textContent='Current PIN is incorrect'; e.classList.remove('hidden'); return; }
  if (!/^\d{4}$/.test(np)) { e.textContent='New PIN must be 4 digits'; e.classList.remove('hidden'); return; }
  if (np!==cf) { e.textContent='PINs do not match'; e.classList.remove('hidden'); return; }
  Storage.setPin(np); els.currentPinInput.value=''; els.newPinInput.value=''; els.confirmPinInput.value='';
  e.classList.add('hidden'); navBack();
}

// ============================================
// EXPORT / IMPORT
// ============================================
function dateStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function buildExportPayload() {
  return {
    lessons: Storage.getLessons(),
    stickers: Storage._load().stickers,
    exportedAt: Date.now(),
    version: 4,
  };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportData() {
  const json = JSON.stringify(buildExportPayload(), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  downloadBlob(blob, 'ctutor-backup-' + dateStr() + '.json');
}

async function shareData() {
  const lessons = Storage.getLessons();
  if (lessons.length === 0) {
    alert('No lessons to share');
    return;
  }
  const payload = buildExportPayload();
  const json = JSON.stringify(payload);

  // Try URL-based share if compressed payload is reasonably short.
  // LZString.compressToEncodedURIComponent gives URL-safe output and
  // shrinks JSON dramatically (repetitive keys compress well).
  const encoded = LZString.compressToEncodedURIComponent(json);
  if (encoded.length <= 1800) {
    const url = location.origin + location.pathname + '?d=' + encoded;
    if (navigator.share) {
      try {
        // Combine friendly label + URL into a single `text` field. Passing
        // `text` and `url` as separate fields makes iOS Messages split them
        // into two bubbles; one combined text field stays as one message
        // and iOS still autolinks the URL.
        await navigator.share({ text: 'Tap to import Chinese Tutor data: ' + url });
        return;
      } catch (e) { if (e.name !== 'AbortError') console.warn('share failed:', e); }
    }
    // Fallback: copy to clipboard
    if (navigator.clipboard) {
      try { await navigator.clipboard.writeText(url); alert('Link copied to clipboard'); return; }
      catch (e) { /* fall through to file */ }
    }
  }

  // Large payload (or URL share failed): share as a .ctutor file
  const blob = new Blob([json], { type: 'application/json' });
  const filename = 'ctutor-backup-' + dateStr() + '.ctutor';
  try {
    const file = new File([blob], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Chinese Tutor Data' });
      return;
    }
  } catch (e) { if (e.name !== 'AbortError') console.warn('file share failed:', e); }

  // Final fallback: download
  downloadBlob(blob, filename);
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || !Array.isArray(data.lessons)) throw new Error('Missing lessons array');
      showImportDialog(data);
    } catch (err) {
      alert('Failed to import: ' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

let pendingImportData = null;
function showImportDialog(data) {
  pendingImportData = data;
  els.importSummary.textContent = data.lessons.length + ' lesson(s) in file';
  els.btnImportMoreOptions.classList.add('hidden');
  els.btnImportShowMore.classList.remove('hidden');
  els.importDialog.classList.remove('hidden');
}
function closeImportDialog() {
  els.importDialog.classList.add('hidden');
  pendingImportData = null;
}
function doImport(mode) {
  if (!pendingImportData) return;
  try {
    let result;
    if (mode === 'replace') {
      if (!confirm('This will REPLACE all existing lessons and progress. Are you sure?')) return;
      result = replaceImportedData(pendingImportData);
    } else {
      result = mergeImportedData(pendingImportData);
    }
    closeImportDialog();
    alert(mode === 'replace'
      ? 'Replaced with ' + result.total + ' lesson(s).'
      : 'Imported ' + result.added + ' new lesson(s), merged ' + result.merged + ' existing.');
    if (state.mode === 'learner') renderLearnerDashboard();
    if (state.mode === 'parent') renderParentDashboard();
  } catch (err) {
    alert('Failed to import: ' + err.message);
  }
}

function replaceImportedData(data) {
  if (!data || !Array.isArray(data.lessons)) throw new Error('Invalid payload: missing lessons array');
  const cur = Storage._load();
  cur.lessons = data.lessons;
  if (data.stickers && Array.isArray(data.stickers.owned)) {
    cur.stickers = {
      owned: data.stickers.owned.slice(),
      history: Array.isArray(data.stickers.history) ? data.stickers.history.slice() : [],
      claims: (data.stickers.claims && typeof data.stickers.claims === 'object') ? Object.assign({}, data.stickers.claims) : {},
    };
  }
  Storage._save();
  return { total: data.lessons.length };
}

function lessonKey(l) {
  // Fallback identity: normalized name + phrase chars (so independently
  // created copies of the same lesson can still be detected as duplicates).
  const name = (l.name || '').trim().toLowerCase();
  const phrases = (l.phrases || []).map(p => (p || '').trim()).join('|');
  return name + '::' + phrases;
}
function mergeImportedData(data) {
  if (!data || !Array.isArray(data.lessons)) throw new Error('Invalid payload: missing lessons array');
  const cur = Storage._load();
  const localById = {};
  const localByKey = {};
  cur.lessons.forEach(l => {
    localById[l.id] = l;
    localByKey[lessonKey(l)] = l;
  });

  let added = 0, merged = 0;
  data.lessons.forEach(remote => {
    let local = localById[remote.id] || localByKey[lessonKey(remote)];
    if (!local) {
      cur.lessons.push(remote);
      localById[remote.id] = remote;
      localByKey[lessonKey(remote)] = remote;
      added++;
    } else {
      mergeLesson(local, remote);
      merged++;
    }
  });

  // Merge stickers: union owned IDs, append new history entries, merge claims
  if (data.stickers) {
    cur.stickers = cur.stickers || { owned: [], history: [], claims: {} };
    if (!cur.stickers.claims) cur.stickers.claims = {};
    if (Array.isArray(data.stickers.owned)) {
      const ownedSet = new Set(cur.stickers.owned);
      data.stickers.owned.forEach(id => ownedSet.add(id));
      cur.stickers.owned = Array.from(ownedSet).sort((a, b) => a - b);
    }
    if (Array.isArray(data.stickers.history)) {
      const seen = new Set(cur.stickers.history.map(h => h.compId + ':' + h.id));
      data.stickers.history.forEach(h => {
        const key = h.compId + ':' + h.id;
        if (!seen.has(key)) { cur.stickers.history.push(h); seen.add(key); }
      });
    }
    if (data.stickers.claims && typeof data.stickers.claims === 'object') {
      Object.keys(data.stickers.claims).forEach(id => {
        const remoteClaim = data.stickers.claims[id];
        const localClaim = cur.stickers.claims[id];
        // Keep the most recently claimed entry
        if (!localClaim || (remoteClaim.claimedAt || 0) > (localClaim.claimedAt || 0)) {
          cur.stickers.claims[id] = remoteClaim;
        }
      });
    }
  }

  Storage._save();
  return { added: added, merged: merged };
}

function mergeLesson(local, remote) {
  // Name/phrases: prefer most recently updated, default to remote when no timestamps
  if ((remote.updatedAt || 0) >= (local.updatedAt || 0)) {
    local.name = remote.name;
    local.phrases = remote.phrases;
    if (remote.updatedAt) local.updatedAt = remote.updatedAt;
  }

  // Progress: keep the side with more completed sections
  const localProg = local.progress || null;
  const remoteProg = remote.progress || null;
  const localDone = (localProg && localProg.completedSections || []).length;
  const remoteDone = (remoteProg && remoteProg.completedSections || []).length;
  if (remoteDone > localDone) {
    local.progress = remoteProg;
  } else if (remoteDone > 0 && remoteDone === localDone) {
    // Same section count — merge sectionScores by max
    local.progress = local.progress || {};
    local.progress.sectionScores = local.progress.sectionScores || {};
    Object.keys(remoteProg.sectionScores || {}).forEach(k => {
      local.progress.sectionScores[k] = Math.max(
        local.progress.sectionScores[k] || 0,
        remoteProg.sectionScores[k] || 0
      );
    });
  }

  // Completions: union by ID, prefer non-empty notes
  local.completions = local.completions || [];
  const compById = {};
  local.completions.forEach(c => { compById[c.id] = c; });
  (remote.completions || []).forEach(rc => {
    const lc = compById[rc.id];
    if (!lc) {
      local.completions.push(rc);
    } else {
      if (!lc.note && rc.note) lc.note = rc.note;
    }
  });

  // Skip request: keep the more recent one (by createdAt)
  if (remote.skipRequest && typeof remote.skipRequest === 'object') {
    const lr = local.skipRequest;
    if (!lr || (remote.skipRequest.createdAt || 0) > (lr.createdAt || 0)) {
      local.skipRequest = remote.skipRequest;
    }
  }

  // Practice attempts: union by timestamp (sort newest first after merge)
  if (Array.isArray(remote.attempts) && remote.attempts.length > 0) {
    local.attempts = local.attempts || [];
    const seen = new Set(local.attempts.map(a => a.timestamp));
    remote.attempts.forEach(a => {
      if (a && a.timestamp && !seen.has(a.timestamp)) {
        local.attempts.push(a);
        seen.add(a.timestamp);
      }
    });
    local.attempts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }
}

function checkUrlImport() {
  const params = new URLSearchParams(location.search);
  const compact = params.get('d');
  const legacy = params.get('import');
  const skipReq = params.get('sr');
  const skipApp = params.get('sa');
  if (!compact && !legacy && !skipReq && !skipApp) return;
  // Clean URL so reloading doesn't re-prompt
  history.replaceState({}, '', location.pathname);
  try {
    if (skipReq) {
      const json = LZString.decompressFromEncodedURIComponent(skipReq);
      if (!json) throw new Error('Could not decompress link');
      ingestSkipRequest(JSON.parse(json));
      return;
    }
    if (skipApp) {
      const json = LZString.decompressFromEncodedURIComponent(skipApp);
      if (!json) throw new Error('Could not decompress link');
      ingestSkipApproval(JSON.parse(json));
      return;
    }
    let json;
    if (compact) {
      json = LZString.decompressFromEncodedURIComponent(compact);
      if (!json) throw new Error('Could not decompress link');
    } else {
      json = decodeURIComponent(escape(atob(decodeURIComponent(legacy))));
    }
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.lessons)) throw new Error('Missing lessons array');
    showImportDialog(data);
  } catch (e) {
    alert('Invalid link: ' + e.message);
  }
}

// ============================================
// SECTION MENU
// ============================================
function computeSectionStatus() {
  const s = {};
  const done = id => state.completedSections.includes(id);
  s.guided = done('guided') ? 'done' : 'unlocked';
  s.free = done('guided') ? (done('free') ? 'done' : 'unlocked') : 'locked';
  s.tingxie = done('free') ? (done('tingxie') ? 'done' : 'unlocked') : 'locked';
  // Each revision attempt produces a guided + free sublesson
  state.revisionAttempts.forEach((att, i) => {
    const gid = 'revision-' + i + '-guided';
    const fid = 'revision-' + i + '-free';
    // Guided unlocks once tingxie is done
    if (done('tingxie')) {
      s[gid] = done(gid) ? 'done' : 'unlocked';
      s[fid] = done(gid) ? (done(fid) ? 'done' : 'unlocked') : 'locked';
    } else {
      s[gid] = 'locked';
      s[fid] = 'locked';
    }
  });
  return s;
}

function canCompleteLesson() {
  const s = computeSectionStatus();
  const base = s.guided === 'done' && s.free === 'done' && s.tingxie === 'done';
  if (!base) return false;
  // Tingxie must have been awarded full points (which only happens when all
  // pending revisions at award time are done, or tingxie was perfect)
  if (state.sectionScores.tingxie < SECTION_SCORES.tingxie) return false;
  return true;
}

function calcTotalScore() {
  return state.sectionScores.guided + state.sectionScores.free + state.sectionScores.tingxie + state.sectionScores.bonus;
}

function getRevisionSection(attemptIdx, type) {
  const att = state.revisionAttempts[attemptIdx];
  if (!att) return null;
  const base = type === 'guided' ? REVISION_GUIDED_BASE : REVISION_FREE_BASE;
  return Object.assign({}, base, {
    id: 'revision-' + attemptIdx + '-' + type,
    name: 'Revision ' + (attemptIdx + 1) + ' \u00b7 ' + (type === 'guided' ? 'Guided' : 'Free'),
    _revisionAttemptIdx: attemptIdx,
    _revisionType: type,
  });
}

function renderSectionMenu() {
  const status = computeSectionStatus();
  els.sectionMenuScore.textContent = calcTotalScore() + ' / 100';

  els.sectionMenuList.innerHTML = '';
  const cards = SECTIONS.map(sec => ({ sec: sec, isRevision: false }));
  state.revisionAttempts.forEach((att, i) => {
    cards.push({ sec: getRevisionSection(i, 'guided'), isRevision: true, attemptIdx: i });
    cards.push({ sec: getRevisionSection(i, 'free'), isRevision: true, attemptIdx: i });
  });

  cards.forEach(item => {
    const sec = item.sec;
    const st = status[sec.id] || 'locked';
    const card = document.createElement('div');
    card.className = 'section-menu-card ' + st;
    card.dataset.section = sec.id;

    let icon = '\uD83D\uDD12'; // lock
    if (st === 'unlocked') icon = '\u25B6'; // play
    if (st === 'done') icon = '\u2714'; // checkmark

    let pts = '\u2014';
    if (item.isRevision) {
      const att = state.revisionAttempts[item.attemptIdx];
      pts = att.phrases.length + ' phrases';
    } else if (st === 'done') {
      pts = state.sectionScores[sec.id] + ' pts';
    } else {
      pts = SECTION_SCORES[sec.id] + ' pts';
    }

    card.innerHTML =
      '<div class="section-menu-icon">' + icon + '</div>' +
      '<div class="section-menu-info"><div class="section-menu-name">' + esc(sec.name) + '</div>' +
      '<div class="section-menu-desc">' + esc(sec.desc) + '</div></div>' +
      '<div class="section-menu-points">' + pts + '</div>';

    if (st !== 'locked') {
      card.addEventListener('click', () => enterSection(sec.id));
    }
    els.sectionMenuList.appendChild(card);
  });

  els.btnCompleteLesson.disabled = !canCompleteLesson();
}

// ============================================
// PRACTICE - SECTION PIPELINE
// ============================================
function getActiveSection() {
  const id = state.activeSectionId;
  if (!id) return null;
  if (id.indexOf('revision-') === 0) {
    const m = id.match(/^revision-(\d+)-(guided|free)$/);
    if (!m) return null;
    return getRevisionSection(parseInt(m[1]), m[2]);
  }
  return SECTIONS.find(s => s.id === id);
}
function getCurrentPhrase() { return state.phrases[state.phraseOrder[state.phraseOrderIdx]]; }
function getCurrentChar() { return getCurrentPhrase()[state.currentCharIdx]; }
function getCurrentPhraseIdx() { return state.phraseOrder[state.phraseOrderIdx]; }

async function startLesson(lessonId) {
  const lesson = Storage.getLesson(lessonId); if (!lesson) return;
  state.currentLessonId = lessonId;
  state.phrases = lesson.phrases.slice();

  // Restore saved progress if any, otherwise start fresh
  const saved = Storage.getLessonProgress(lessonId);
  if (saved) {
    state.sectionScores = saved.sectionScores || { guided: 0, free: 0, tingxie: 0, bonus: 0 };
    state.completedSections = saved.completedSections || [];
    state.revisionAttempts = saved.revisionAttempts || [];
    state.tingxieResults = saved.tingxieResults || {};
  } else {
    state.sectionScores = { guided: 0, free: 0, tingxie: 0, bonus: 0 };
    state.completedSections = [];
    state.revisionAttempts = [];
    state.tingxieResults = {};
  }
  state.activeSectionId = null;

  // Apply skip permission if approved — auto-mark guided & free as done.
  // The permission stays active across restarts and is only consumed when
  // the lesson is fully completed (see showResults).
  const skipReq = Storage.getSkipRequest(lessonId);
  if (state.mode === 'learner' && skipReq && skipReq.status === 'approved') {
    if (!state.completedSections.includes('guided')) state.completedSections.push('guided');
    if (!state.completedSections.includes('free')) state.completedSections.push('free');
    persistLessonProgress();
  }

  // Fetch dict data for all unique characters
  const allChars = [...new Set(state.phrases.join('').split(''))].filter(c => CJK_REGEX.test(c));
  await fetchDictData(allChars);

  const lesson2 = Storage.getLesson(lessonId);
  navigateTo('section-menu', lesson2.name);
}

function persistLessonProgress() {
  if (!state.currentLessonId) return;
  Storage.saveLessonProgress(state.currentLessonId, {
    sectionScores: state.sectionScores,
    completedSections: state.completedSections,
    revisionAttempts: state.revisionAttempts,
    tingxieResults: state.tingxieResults,
  });
}

function enterSection(sectionId) {
  state.activeSectionId = sectionId;
  const sec = getActiveSection();

  // Build phrase order
  if (sec._revisionAttemptIdx !== undefined) {
    const att = state.revisionAttempts[sec._revisionAttemptIdx];
    state.phraseOrder = att.phrases.slice();
  } else {
    state.phraseOrder = state.phrases.map((_, i) => i);
    if (sec.randomize) {
      for (let i = state.phraseOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.phraseOrder[i], state.phraseOrder[j]] = [state.phraseOrder[j], state.phraseOrder[i]];
      }
    }
  }
  state.phraseOrderIdx = 0;

  // Reset tingxie tracking for this run
  if (sectionId === 'tingxie') {
    state.tingxieResults = {};
  }

  // Initialize per-attempt stats for parent review
  state.attemptStats = {
    sectionId: sectionId,
    sectionName: sec.name,
    timestamp: Date.now(),
    totalChars: 0,
    totalMistakes: 0,
    skipped: 0,
  };

  const lesson = Storage.getLesson(state.currentLessonId);
  navigateTo('practice', lesson.name);
  renderSectionLabel();
  updateControls();
  startPhrase();
}

function renderSectionLabel() {
  const sec = getActiveSection();
  els.sectionTabs.innerHTML = '<div class="section-tab-label">' + esc(sec.name) + '</div>';
}

function exitSection() {
  const sectionId = state.activeSectionId;
  const isRevision = sectionId.indexOf('revision-') === 0;

  // Mark completed (if not already)
  if (!state.completedSections.includes(sectionId)) {
    state.completedSections.push(sectionId);
  }

  // Save the attempt stats record on the lesson for parent review
  if (state.attemptStats) {
    Storage.addAttemptStats(state.currentLessonId, state.attemptStats);
    state.attemptStats = null;
  }

  // Award score (one-time per section)
  if (sectionId === 'tingxie') {
    // Detect newly failed phrases from this attempt and append a revision attempt if any
    const failedPhrases = collectFailedTingxiePhrases();
    if (failedPhrases.length > 0) {
      state.revisionAttempts.push({ phrases: failedPhrases });
    }
    checkAndAwardTingxie();
  } else if (isRevision) {
    checkAndAwardTingxie();
  } else {
    if (state.sectionScores[sectionId] === 0) {
      state.sectionScores[sectionId] = SECTION_SCORES[sectionId];
    }
  }

  destroyWriters();

  // Persist progress so the student can come back later
  persistLessonProgress();

  // Show confetti on section menu, then navigate
  const lesson = Storage.getLesson(state.currentLessonId);
  navigateTo('section-menu', lesson.name, {replace: true});
  // Remove practice from nav stack
  state.navStack = state.navStack.filter(n => n.screenId !== 'practice');
  launchConfetti(els.confettiContainerMenu);
}

function collectFailedTingxiePhrases() {
  const failed = [];
  for (const piStr in state.tingxieResults) {
    const pi = parseInt(piStr);
    const results = state.tingxieResults[pi];
    if (results && results.some(r => !r)) failed.push(pi);
  }
  return failed;
}

function checkAndAwardTingxie() {
  if (state.sectionScores.tingxie >= SECTION_SCORES.tingxie) return; // already awarded
  if (!state.completedSections.includes('tingxie')) return;
  // All revisions must be done
  for (let i = 0; i < state.revisionAttempts.length; i++) {
    if (!state.completedSections.includes('revision-' + i + '-guided')) return;
    if (!state.completedSections.includes('revision-' + i + '-free')) return;
  }
  state.sectionScores.tingxie = SECTION_SCORES.tingxie;
}

function completeLesson() {
  if (!canCompleteLesson()) return;
  state.sectionScores.bonus = SECTION_SCORES.bonus;
  showResults();
}

function startPhrase() {
  state.currentCharIdx = 0;
  state.roundNum = 1;
  state.guidedTotal = getActiveSection().rounds || 1;
  state.tingxieCharResults = [];
  state.isAnimating = false;

  destroyWriters();
  renderPhraseWriters();
  renderTingxieBoxes();
  updatePracticeUI();
  startCharacter();

  // Auto-speak the full phrase at the start of each phrase
  speakText(getCurrentPhrase());
}

function renderPhraseWriters() {
  const sec = getActiveSection();
  const phrase = getCurrentPhrase();

  state.phraseWriters = [];
  els.phraseCharsDisplay.innerHTML = '';

  if (!sec.showRef) return;

  for (let i = 0; i < phrase.length; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'phrase-char-hw' + (i === state.currentCharIdx ? ' active' : '');
    wrapper.dataset.idx = i;
    els.phraseCharsDisplay.appendChild(wrapper);

    const writer = HanziWriter.create(wrapper, phrase[i], {
      width: 36, height: 36, padding: 2,
      strokeColor: '#333', outlineColor: '#ddd',
    });
    writer.showCharacter();
    writer.showOutline();
    state.phraseWriters.push(writer);
  }
}

function updatePhraseHighlight() {
  const wrappers = els.phraseCharsDisplay.querySelectorAll('.phrase-char-hw');
  wrappers.forEach((w, i) => {
    w.classList.toggle('active', i === state.currentCharIdx);
  });
}

function renderTingxieBoxes() {
  els.tingxieCharsDisplay.innerHTML = '';
  const sec = getActiveSection();
  if (!sec.perCharScoring) return;

  const phrase = getCurrentPhrase();
  for (let i = 0; i < phrase.length; i++) {
    const box = document.createElement('div');
    box.className = 'tingxie-char-box' + (i === state.currentCharIdx ? ' active' : '');
    box.dataset.idx = i;
    els.tingxieCharsDisplay.appendChild(box);
  }
}

function updateTingxieHighlight() {
  const boxes = els.tingxieCharsDisplay.querySelectorAll('.tingxie-char-box');
  boxes.forEach((b, i) => {
    if (!b.classList.contains('completed')) {
      b.classList.toggle('active', i === state.currentCharIdx);
    }
  });
}

function revealTingxieChar(charIdx) {
  const boxes = els.tingxieCharsDisplay.querySelectorAll('.tingxie-char-box');
  const box = boxes[charIdx];
  if (!box || box.classList.contains('completed')) return;
  box.classList.remove('active');
  box.classList.add('completed');
  const char = getCurrentPhrase()[charIdx];
  const writer = HanziWriter.create(box, char, {
    width: 40, height: 40, padding: 2,
    strokeColor: '#2c3e50', outlineColor: '#ddd',
  });
  writer.showCharacter();
  writer.showOutline();
}

function startCharacter() {
  const sec = getActiveSection();
  const char = getCurrentChar();
  state.charAttempts = 0;

  updatePracticeUI();
  updateCharDetails();

  // Reference area
  if (sec.showRef) {
    els.refArea.classList.remove('hidden');
    els.tingxieArea.classList.add('hidden');
    if (state.refWriter) state.refWriter.setCharacter(char);
    else state.refWriter = HanziWriter.create(els.refWriterTarget, char, {
      width: 80, height: 80, padding: 5, strokeColor: '#333', outlineColor: '#ccc',
      strokeAnimationSpeed: 1, delayBetweenStrokes: 300,
    });
  } else {
    els.refArea.classList.add('hidden');
    els.tingxieArea.classList.remove('hidden');
    updateTingxieHighlight();
  }

  // Quiz writer
  createQuizWriter(char, sec.showOutline && state.roundNum <= state.guidedTotal);
}

function createQuizWriter(char, showOutline) {
  els.quizWriterTarget.innerHTML = '';
  const container = $('practice-bottom');
  const size = Math.min(container.clientWidth - 20, container.clientHeight - 20, 320);

  state.quizWriter = HanziWriter.create(els.quizWriterTarget, char, {
    width: size, height: size, padding: 15,
    strokeColor: '#555', outlineColor: '#ddd',
    drawingColor: '#4CAF50', drawingWidth: 8,
    showOutline: showOutline, showCharacter: false,
    highlightColor: '#aaf',
    showHintAfterMisses: showOutline ? 3 : false,
    highlightOnComplete: false,
    leniency: 2.5,
  });

  state.quizWriter.quiz({
    onCorrectStroke: onCorrectStroke,
    onMistake: onMistake,
    onComplete: onCharComplete,
  });
}

// ============================================
// QUIZ CALLBACKS
// ============================================
function onCorrectStroke() { flashFeedback('green'); }
function onMistake() {
  flashFeedback('red');
  els.quizWriterTarget.classList.add('shake');
  setTimeout(() => els.quizWriterTarget.classList.remove('shake'), 400);
}

function onCharComplete(data) {
  if (state.isAnimating) return;
  state.isAnimating = true;
  const sec = getActiveSection();
  const isGuided = sec.showOutline && state.roundNum <= state.guidedTotal;

  // Track per-attempt stats for parent review
  if (state.attemptStats) {
    state.attemptStats.totalChars++;
    state.attemptStats.totalMistakes += (data.totalMistakes || 0);
  }

  // For tingxie, track per-char results and reveal the character box
  if (sec.perCharScoring) {
    state.tingxieCharResults[state.currentCharIdx] = (data.totalMistakes <= MAX_MISTAKES_UNGUIDED);
    revealTingxieChar(state.currentCharIdx);
  }

  // Free trace: show fail dialog if too many mistakes (auto-skip after 3 fails)
  if (!isGuided && !sec.perCharScoring && data.totalMistakes > MAX_MISTAKES_UNGUIDED) {
    state.charAttempts++;
    if (state.charAttempts >= 3) {
      // Auto-skip after 3 failed attempts
      state.isAnimating = false;
      state.charAttempts = 0;
      advanceAfterChar();
      return;
    }
    state.isAnimating = false;
    els.failDialog.classList.remove('hidden');
    return;
  }

  state.charAttempts = 0;
  showSuccessFlash(sec.perCharScoring ? '' : 'Nice!', () => {
    state.isAnimating = false;
    advanceAfterChar();
  });
}

function advanceAfterChar() {
  const phrase = getCurrentPhrase();
  if (state.currentCharIdx < phrase.length - 1) {
    state.currentCharIdx++;
    startCharacter();
  } else {
    onRoundComplete();
  }
}

function onRoundComplete() {
  const sec = getActiveSection();

  // Store tingxie results for this phrase
  if (sec.perCharScoring) {
    state.tingxieResults[getCurrentPhraseIdx()] = state.tingxieCharResults.slice();
  }

  // Phrase just finished — celebrate with confetti + 1s pause
  state.isAnimating = true;
  launchConfetti(els.confettiContainer);
  const isMultiRoundSection = sec.id === 'guided' || sec.id.indexOf('revision-') === 0;
  setTimeout(() => {
    state.isAnimating = false;
    if (isMultiRoundSection) {
      if (state.roundNum < state.guidedTotal) {
        state.roundNum++;
        state.currentCharIdx = 0;
        destroyWriters();
        startCharacter();
        // Speak the phrase again at the start of the new round
        speakText(getCurrentPhrase());
      } else {
        advancePhrase();
      }
    } else {
      advancePhrase();
    }
  }, 1000);
}

function advancePhrase() {
  if (state.phraseOrderIdx < state.phraseOrder.length - 1) {
    state.phraseOrderIdx++;
    destroyWriters();
    startPhrase();
  } else {
    // Section complete
    exitSection();
  }
}

// ============================================
// SKIP
// ============================================
function skipCharacter() {
  if (state.isAnimating) return;
  const sec = getActiveSection();
  if (sec.perCharScoring) {
    state.tingxieCharResults[state.currentCharIdx] = false;
    revealTingxieChar(state.currentCharIdx);
  }
  if (state.attemptStats) {
    state.attemptStats.totalChars++;
    state.attemptStats.skipped++;
  }
  advanceAfterChar();
}

// ============================================
// CONTROLS
// ============================================
function updateControls() {
  const sec = getActiveSection();
  const ctrls = sec.controls || [];
  els.btnRestart.classList.toggle('hidden', !ctrls.includes('restart'));
  els.btnGuided.classList.toggle('hidden', !ctrls.includes('guided'));
  els.btnAnimate.classList.toggle('hidden', !ctrls.includes('animate'));
  els.btnSkip.classList.toggle('hidden', !ctrls.includes('skip'));
}

function switchToGuided() {
  if (state.isAnimating) return;
  state.guidedTotal++;
  state.roundNum = state.guidedTotal;
  createQuizWriter(getCurrentChar(), true);
  updatePracticeUI();
}

function retryWithGuided() {
  els.failDialog.classList.add('hidden');
  state.guidedTotal++;
  state.roundNum = state.guidedTotal;
  createQuizWriter(getCurrentChar(), true);
  updatePracticeUI();
}

function retryFree() {
  els.failDialog.classList.add('hidden');
  createQuizWriter(getCurrentChar(), false);
}

function restartCurrentTrace() {
  if (state.isAnimating) return;
  const sec = getActiveSection();
  const isGuided = sec.showOutline && state.roundNum <= state.guidedTotal;
  createQuizWriter(getCurrentChar(), isGuided);
}

function showAnimation() {
  if (state.isAnimating || !state.refWriter) return;
  state.isAnimating = true;
  state.refWriter.animateCharacter({ onComplete: () => { state.isAnimating = false; } });
}

// ============================================
// UI UPDATES
// ============================================
function updatePracticeUI() {
  const sec = getActiveSection();

  // Phrase bar
  els.phraseProgress.textContent = 'Phrase ' + (state.phraseOrderIdx + 1) + '/' + state.phraseOrder.length;
  els.practiceScore.textContent = sec.name;

  updatePhraseHighlight();

  // Progress info
  const isRevisionGuided = sec.id.indexOf('revision-') === 0 && sec._revisionType === 'guided';
  const isRevisionFree = sec.id.indexOf('revision-') === 0 && sec._revisionType === 'free';
  if (sec.id === 'guided' || isRevisionGuided) {
    els.attemptDisplay.textContent = 'Round ' + state.roundNum + '/' + state.guidedTotal;
  } else if (sec.id === 'free' || isRevisionFree) {
    const isGuided = state.roundNum <= state.guidedTotal && state.guidedTotal > 1;
    els.attemptDisplay.textContent = isGuided ? 'Guided ' + state.roundNum + '/' + state.guidedTotal : 'Free Trace';
  } else {
    els.attemptDisplay.textContent = '';
  }

  if (sec.id === 'free' || isRevisionFree) {
    els.btnGuided.classList.remove('hidden');
  }
}

// ============================================
// RESULTS & REWARD
// ============================================
function showResults() {
  const total = calcTotalScore();
  const lesson = Storage.getLesson(state.currentLessonId);
  const cycle = lesson.completions.length;

  const comp = Storage.addCompletion(state.currentLessonId, {
    cycle: cycle + 1, score: total, maxScore: 100,
  });

  // Award a sticker for this completion
  const sticker = Storage.awardRandomSticker(state.currentLessonId, comp.id);

  // Lesson fully complete — clear in-progress state and consume any skip permission
  Storage.clearLessonProgress(state.currentLessonId);
  const skipReq = Storage.getSkipRequest(state.currentLessonId);
  if (skipReq && skipReq.status === 'approved') {
    Storage.setSkipRequest(state.currentLessonId, null);
  }

  els.scoreSummary.innerHTML =
    '<div class="score-big">' + total + ' / 100</div>' +
    '<div>Guided: ' + state.sectionScores.guided + ' \u00b7 Free: ' + state.sectionScores.free +
    ' \u00b7 \u542C\u5199: ' + state.sectionScores.tingxie + ' \u00b7 Bonus: ' + state.sectionScores.bonus + '</div>';

  // Sticker reveal
  els.stickerReveal.classList.remove('hidden');
  els.stickerReveal.querySelector('.sticker-reveal-label').textContent =
    sticker.isNew ? 'New sticker unlocked!' : 'Bonus sticker!';
  els.stickerRevealImg.src = stickerUrl(sticker.id);
  els.stickerRevealProgress.textContent =
    Storage.getStickerCount() + ' / ' + STICKER_POOL_SIZE + ' collected';

  destroyWriters();
  navigateTo('reward', 'Lesson Complete!');
  launchConfetti(els.confettiContainer);
}

// ============================================
// DICTIONARY & PINYIN
// ============================================
function numPinyinToTone(s) {
  const tones = { a:'\u0101\u00e1\u01ce\u00e0a', e:'\u0113\u00e9\u011b\u00e8e', i:'\u012b\u00ed\u01d0\u00eci', o:'\u014d\u00f3\u01d2\u00f2o', u:'\u016b\u00fa\u01d4\u00f9u', v:'\u01d6\u01d8\u01da\u01dc\u00fc' };
  const m = s.match(/^([a-z\u00fc]+)(\d)$/i); if (!m) return s;
  let syl = m[1].toLowerCase().replace(/\u00fc/g,'v');
  const tone = parseInt(m[2]); if (tone<1||tone>5) return s;
  let idx = -1;
  if (syl.includes('a')) idx=syl.indexOf('a');
  else if (syl.includes('e')) idx=syl.indexOf('e');
  else if (syl.includes('ou')) idx=syl.indexOf('o');
  else { for(let i=syl.length-1;i>=0;i--){ if('aeiouv'.includes(syl[i])){idx=i;break;} } }
  if (idx===-1) return syl;
  return syl.substring(0,idx) + tones[syl[idx]][tone-1] + syl.substring(idx+1);
}

async function fetchDictData(chars) {
  await Promise.all(chars.map(async ch => {
    if (state.dictCache[ch]) return;
    try {
      const r = await fetch(CEDICT_URL + encodeURIComponent(ch) + '.json');
      if (!r.ok) throw 0; const d = await r.json();
      const py = (d.pinyin||[])[0]; const def = Object.values(d.definitions||{})[0]||'';
      state.dictCache[ch] = { pinyin: py ? numPinyinToTone(py) : '\u2014', meaning: def.split(/;\s*/).filter(Boolean).slice(0,2).join('; ') };
    } catch(e) { state.dictCache[ch] = { pinyin:'\u2014', meaning:'\u2014' }; }
  }));
}

function updateCharDetails() {
  const sec = getActiveSection();
  if (!sec.showRef) return;
  const ch = getCurrentChar();
  const info = state.dictCache[ch] || { pinyin:'', meaning:'' };
  els.pinyinDisplay.textContent = info.pinyin;
  els.meaningDisplay.textContent = info.meaning;
}

// ============================================
// SPEECH
// ============================================
let voicesReady = false;
function ensureVoices() {
  return new Promise(r => {
    if (speechSynthesis.getVoices().length) { voicesReady = true; r(); return; }
    speechSynthesis.addEventListener('voiceschanged', () => { voicesReady = true; r(); }, {once: true});
  });
}
function testSpeech() {
  if (!('speechSynthesis' in window)) {
    alert('speechSynthesis API is NOT available in this browser');
    return;
  }
  // Speak FIRST, while user gesture is still fresh (alert consumes it)
  const voices = speechSynthesis.getVoices();
  const zhVoices = voices.filter(v => v.lang.toLowerCase().startsWith('zh'));
  let lastError = '';
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance('\u4F60\u597D');
    u.lang = 'zh-CN'; u.rate = 0.8; u.volume = 1;
    if (zhVoices[0]) u.voice = zhVoices[0];
    u.onerror = (e) => { lastError = e.error || 'unknown'; };
    speechSynthesis.speak(u);
  } catch (e) {
    lastError = 'exception: ' + e.message;
  }
  // Report after speak is queued
  setTimeout(() => {
    let report = 'Total voices: ' + voices.length + '\n';
    report += 'Chinese voices: ' + zhVoices.length + '\n';
    if (zhVoices.length > 0) {
      report += '\nChinese voices found:\n';
      zhVoices.slice(0, 9).forEach(v => { report += '  - ' + v.name + ' (' + v.lang + ')\n'; });
    }
    report += '\nspeaking: ' + speechSynthesis.speaking + '\n';
    report += 'pending: ' + speechSynthesis.pending + '\n';
    if (lastError) report += '\nERROR: ' + lastError;
    alert(report);
  }, 300);
}

async function speakText(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  if (!voicesReady) await ensureVoices();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN'; u.rate = 0.8;
  const v = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith('zh'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

// ============================================
// UTILITIES
// ============================================
function destroyWriters() {
  if (state.refWriter) { els.refWriterTarget.innerHTML=''; state.refWriter=null; }
  els.quizWriterTarget.innerHTML=''; state.quizWriter=null;
  state.phraseWriters = [];
}
function flashFeedback(color) {
  const o=els.feedbackOverlay; o.classList.remove('hidden','flash-red','flash-green');
  void o.offsetWidth; o.classList.add('flash-'+color);
  setTimeout(()=>{o.classList.add('hidden');o.classList.remove('flash-red','flash-green');},400);
}
function showSuccessFlash(text, cb) {
  if (!text) { if(cb) cb(); return; }
  const o=els.successOverlay; o.querySelector('.overlay-text').textContent=text;
  o.classList.remove('hidden'); setTimeout(()=>{o.classList.add('hidden');if(cb)cb();},800);
}
function launchConfetti(container) {
  container = container || els.confettiContainer;
  container.innerHTML='';
  const colors=['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff8cc8','#a855f7'];
  for(let i=0;i<50;i++){const p=document.createElement('div');p.className='confetti-piece';
  p.style.setProperty('--x',Math.random()*100+'vw');p.style.setProperty('--delay',Math.random()*.8+'s');
  p.style.setProperty('--color',colors[i%colors.length]);p.style.setProperty('--drift',(Math.random()-.5)*200+'px');
  container.appendChild(p);} setTimeout(()=>{container.innerHTML='';},4000);
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
