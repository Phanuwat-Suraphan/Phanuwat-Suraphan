// --- CONFIGURATION ---
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxR1MuytO0_Rb7Mn5d0rF-0hPCNDnGBU3g9sMvls5JdlZE_5tpbVIBCzlxGlyYFFXPmqg/exec';
const LOCAL_STORAGE_KEY = 'squareRootQuestProgress';

// --- DATASETS ---
const exercise1Data = [
    { question: "รากที่สองของ 64 คือ...", answer: "8 และ -8", type: "ตรรกยะ" },
    { question: "รากที่สองของ 13 คือ...", answer: "sqrt(13) และ -sqrt(13)", type: "อตรรกยะ" },
    { question: "รากที่สองของ 36 คือ...", answer: "6 และ -6", type: "ตรรกยะ" },
    { question: "รากที่สองของ 121 คือ...", answer: "11 และ -11", type: "ตรรกยะ" },
    { question: "รากที่สองของ 27 คือ...", answer: "sqrt(27) และ -sqrt(27)", type: "อตรรกยะ" },
    { question: "รากที่สองของ 0 คือ...", answer: "0", type: "ตรรกยะ" },
    { question: "รากที่สองของ 0.09 คือ...", answer: "0.3 และ -0.3", type: "ตรรกยะ" },
    { question: "รากที่สองของ 4/25 คือ...", answer: "2/5 และ -2/5", type: "ตรรกยะ" },
    { question: "รากที่สองของ 1.1 คือ...", answer: "sqrt(1.1) และ -sqrt(1.1)", type: "อตรรกยะ" },
    { question: "รากที่สองของ 3/2 คือ...", answer: "sqrt(3/2) และ -sqrt(3/2)", type: "อตรรกยะ" }
];

const exercise2Data = [
    { question: "จงหารากที่สองของ 625", answer: "25 และ -25" },
    { question: "จงหารากที่สองของ 441", answer: "21 และ -21" },
    { question: "จงหารากที่สองของ 400", answer: "20 และ -20" },
    { question: "จงหารากที่สองของ 324", answer: "18 และ -18" },
    { question: "จงหารากที่สองของ 900", answer: "30 และ -30" }
];

const game1Cards = [
    { id: 1, content: "√81" }, { id: 1, content: "9" },
    { id: 2, content: "รากที่สองของ 49" }, { id: 2, content: "7 และ -7" },
    { id: 3, content: "-√144" }, { id: 3, content: "-12" },
    { id: 4, content: "√(-5)²" }, { id: 4, content: "5" },
    { id: 5, content: "รากที่สองของ 1" }, { id: 5, content: "1 และ -1" },
    { id: 6, content: "√400" }, { id: 6, content: "20" },
    { id: 7, content: "รากที่สองของ 0" }, { id: 7, content: "0" },
    { id: 8, content: "√0.04" }, { id: 8, content: "0.2" }
];

const game2Data = [
    { question: "ข้อใดคือค่าของ √(-15)²?", options: ["15", "-15", "±15"], answer: "15" },
    { question: "รากที่สองของ 1.21 คือข้อใด?", options: ["1.1", "-1.1", "1.1 และ -1.1"], answer: "1.1 และ -1.1" },
    { question: "ข้อใดคือ 'กรณฑ์ที่สองของ 100'?", options: ["10", "-10", "10 และ -10"], answer: "10" },
    { question: "ถ้า x² = 16 แล้ว x มีค่าเท่าใด?", options: ["4", "-4", "4 และ -4"], answer: "4 และ -4" },
    { question: "รากที่สองของ 5 เป็นจำนวนชนิดใด?", options: ["ตรรกยะ", "อตรรกยะ"], answer: "อตรรกยะ" },
    { question: "ค่าของ -√49 คือข้อใด?", options: ["7", "-7", "±7"], answer: "-7" },
    { question: "√36 + √64 =?", options: ["√100", "14", "100"], answer: "14" },
    { question: "รากที่สองของ -25 คือข้อใด?", options: ["5i", "-5", "ไม่มีในระบบจำนวนจริง"], answer: "ไม่มีในระบบจำนวนจริง" },
    { question: "ข้อใดถูกต้อง?", options: ["√x² = x", "√x² = |x|"], answer: "√x² = |x|" },
    { question: "รากที่สองของ 2/8 เป็นจำนวนชนิดใด?", options: ["ตรรกยะ", "อตรรกยะ"], answer: "ตรรกยะ" }
];

const testData = [
    { question: "ข้อใดคือความหมายของ 'รากที่สองของ a'?", answer: "จำนวนจริงที่ยกกำลังสองแล้วได้ a" },
    { question: "ค่าของ √169 คือเท่าใด?", answer: "13" },
    { question: "รากที่สองของ 196 คือเท่าใด?", answer: "14 และ -14" },
    { question: "ค่าของ √(-20)² คือเท่าใด?", answer: "20" },
    { question: "รากที่สองของ 0.0001 คือเท่าใด?", answer: "0.01 และ -0.01" }
];

// --- STATE MANAGEMENT ---
let studentData = {};
let currentQuestionIndex = 0;
let activeDataset =;
let game1TimerInterval;

// --- INITIALIZATION ---
window.addEventListener('load', loadProgress);
document.getElementById('registration-form').addEventListener('submit', handleRegistration);

// --- CORE FUNCTIONS ---
function handleRegistration(e) {
    e.preventDefault();
    studentData = {
        fullName: document.getElementById('fullName').value,
        studentId: document.getElementById('studentId').value,
        studentClass: document.getElementById('studentClass').value,
        scores: { ex1: 0, ex2: 0, game1: 0, game2: 0, test: 0 },
        currentModule: 'intro-module'
    };
    goToModule('intro-module');
}

function goToModule(moduleId) {
    document.querySelectorAll('.module').forEach(module => module.classList.remove('active'));
    document.getElementById(moduleId).classList.add('active');
    studentData.currentModule = moduleId;
    if (studentData.fullName) saveProgress();

    // Initialize module if needed
    if (moduleId === 'exercise-module-1') setupExercise(1, exercise1Data);
    if (moduleId === 'exercise-module-2') setupExercise(2, exercise2Data);
    if (moduleId === 'game1-module') setupGame1();
    if (moduleId === 'game2-module') setupQuiz(3, game2Data);
    if (moduleId === 'test-module') setupExercise(4, testData);
    if (moduleId === 'summary-module') showSummary();
}

function setupExercise(exNum, data) {
    currentQuestionIndex = 0;
    activeDataset = data;
    if (exNum === 1) studentData.scores.ex1 = 0;
    if (exNum === 2) studentData.scores.ex2 = 0;
    if (exNum === 4) studentData.scores.test = 0;
    renderQuestion(exNum);
}

function renderQuestion(exNum) {
    const q = activeDataset[currentQuestionIndex];
    const containerId = exNum === 1? 'ex1-question-container' : (exNum === 2? 'ex2-question-container' : 'test-question-container');
    const container = document.getElementById(containerId);
    
    let html = `<p>${currentQuestionIndex + 1}. ${q.question}</p>`;
    if (exNum === 1) {
        html += `<input type="text" id="ex1-answer" placeholder="พิมพ์คำตอบ (เช่น 5 และ -5)">
                 <p>ประเภทของจำนวน:</p>
                 <button class="option-btn" onclick="checkAnswer(1, 'ตรรกยะ')">ตรรกยะ</button>
                 <button class="option-btn" onclick="checkAnswer(1, 'อตรรกยะ')">อตรรกยะ</button>`;
    } else { // exNum 2 or 4 (test)
        html += `<input type="text" id="ex-answer" placeholder="พิมพ์คำตอบ">
                 <button onclick="checkAnswer(${exNum})">ตรวจคำตอบ</button>`;
    }
    container.innerHTML = html;
    document.getElementById(exNum === 1? 'ex1-feedback' : (exNum === 2? 'ex2-feedback' : 'test-feedback')).innerHTML = '';
    document.getElementById(exNum === 1? 'ex1-next-btn' : (exNum === 2? 'ex2-next-btn' : 'test-next-btn')).style.display = 'none';
}

function checkAnswer(exNum, selectedType = null) {
    const q = activeDataset[currentQuestionIndex];
    const feedbackEl = document.getElementById(exNum === 1? 'ex1-feedback' : (exNum === 2? 'ex2-feedback' : 'test-feedback'));
    let isCorrect = false;

    if (exNum === 1) {
        const userAnswer = document.getElementById('ex1-answer').value.replace(/\s/g, '');
        const correctAnswer = q.answer.replace(/\s/g, '');
        if (userAnswer === correctAnswer && selectedType === q.type) {
            isCorrect = true;
            studentData.scores.ex1++;
        }
    } else { // exNum 2 or 4
        const userAnswer = document.getElementById('ex-answer').value.replace(/\s/g, '');
        const correctAnswer = q.answer.replace(/\s/g, '');
        if (userAnswer === correctAnswer) {
            isCorrect = true;
            if (exNum === 2) studentData.scores.ex2++;
            if (exNum === 4) studentData.scores.test++;
        }
    }

    feedbackEl.textContent = isCorrect? "ถูกต้อง!" : `ผิด, คำตอบที่ถูกต้องคือ: ${q.answer}` + (q.type? ` (${q.type})` : '');
    feedbackEl.className = `feedback ${isCorrect? 'correct' : 'incorrect'}`;
    document.getElementById(exNum === 1? 'ex1-next-btn' : (exNum === 2? 'ex2-next-btn' : 'test-next-btn')).style.display = 'block';
}

function nextQuestion(type) { // 1: ex1, 2: ex2, 3: game2, 4: test
    currentQuestionIndex++;
    if (currentQuestionIndex < activeDataset.length) {
        if (type === 1 |
| type === 2 |
| type === 4) renderQuestion(type);
        if (type === 3) renderQuizQuestion();
    } else {
        let nextModule = '';
        if (type === 1) nextModule = 'content-module-2';
        if (type === 2) nextModule = 'game1-module';
        if (type === 3) nextModule = 'test-module';
        if (type === 4) nextModule = 'summary-module';
        goToModule(nextModule);
    }
}

// --- Game 1: Matching ---
function setupGame1() {
    const grid = document.getElementById('game1-grid');
    grid.innerHTML = '';
    let flippedCards =;
    let matchedPairs = 0;
    let startTime = Date.now();
    studentData.scores.game1 = 0;

    game1TimerInterval = setInterval(() => {
        document.getElementById('game1-timer').textContent = `เวลา: ${Math.floor((Date.now() - startTime) / 1000)} วินาที`;
    }, 1000);

    const shuffledCards = [...game1Cards].sort(() => 0.5 - Math.random());

    shuffledCards.forEach(cardData => {
        const card = document.createElement('div');
        card.classList.add('card');
        card.dataset.id = cardData.id;
        card.innerHTML = `<div class="card-content">${cardData.content}</div>`;
        card.addEventListener('click', () => {
            if (flippedCards.length < 2 &&!card.classList.contains('flipped')) {
                card.classList.add('flipped');
                flippedCards.push(card);

                if (flippedCards.length === 2) {
                    setTimeout(() => {
                        const [card1, card2] = flippedCards;
                        if (card1.dataset.id === card2.dataset.id) {
                            card1.classList.add('matched');
                            card2.classList.add('matched');
                            matchedPairs++;
                            if (matchedPairs === game1Cards.length / 2) {
                                clearInterval(game1TimerInterval);
                                const timeTaken = Math.floor((Date.now() - startTime) / 1000);
                                studentData.scores.game1 = Math.max(0, 10000 - (timeTaken * 50));
                                confetti();
                            }
                        } else {
                            card1.classList.remove('flipped');
                            card2.classList.remove('flipped');
                        }
                        flippedCards =;
                    }, 1000);
                }
            }
        });
        grid.appendChild(card);
    });
}

// --- Game 2: Quiz ---
function setupQuiz(quizNum, data) {
    currentQuestionIndex = 0;
    activeDataset = data;
    studentData.scores.game2 = 0;
    renderQuizQuestion();
}

function renderQuizQuestion() {
    const q = activeDataset[currentQuestionIndex];
    document.getElementById('game2-question-container').innerHTML = `<p>${currentQuestionIndex + 1}. ${q.question}</p>`;
    const optionsContainer = document.getElementById('game2-options-container');
    optionsContainer.innerHTML = '';
    q.options.forEach(option => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.textContent = option;
        btn.onclick = () => checkQuizAnswer(option);
        optionsContainer.appendChild(btn);
    });
    document.getElementById('game2-feedback').innerHTML = '';
    document.getElementById('game2-next-btn').style.display = 'none';
}

function checkQuizAnswer(selectedOption) {
    const q = activeDataset[currentQuestionIndex];
    const feedbackEl = document.getElementById('game2-feedback');
    let isCorrect = selectedOption === q.answer;
    if (isCorrect) {
        studentData.scores.game2++;
    }
    feedbackEl.textContent = isCorrect? "ถูกต้อง!" : `ผิด, คำตอบที่ถูกต้องคือ: ${q.answer}`;
    feedbackEl.className = `feedback ${isCorrect? 'correct' : 'incorrect'}`;
    document.getElementById('game2-next-btn').style.display = 'block';
}

// --- Summary & Submission ---
function showSummary() {
    const s = studentData.scores;
    document.getElementById('summary-ex1').textContent = s.ex1;
    document.getElementById('summary-ex2').textContent = s.ex2;
    document.getElementById('summary-game1').textContent = s.game1;
    document.getElementById('summary-game2').textContent = s.game2;
    document.getElementById('summary-test').textContent = s.test;
    const total = s.ex1 + s.ex2 + s.game2 + s.test + (s.game1 > 0? 10 : 0); // Simplified total
    document.getElementById('summary-total').textContent = total;
}

async function submitData() {
    const submitBtn = document.getElementById('submit-scores-btn');
    const statusEl = document.getElementById('submission-status');
    submitBtn.disabled = true;
    statusEl.textContent = 'กำลังส่งข้อมูล...';
    statusEl.style.color = 'orange';

    const dataToSend = {
        timestamp: new Date().toISOString(),
        fullName: studentData.fullName,
        studentId: studentData.studentId,
        studentClass: studentData.studentClass,
        exercise1Score: studentData.scores.ex1,
        exercise2Score: studentData.scores.ex2,
        game1Score: studentData.scores.game1,
        game2Score: studentData.scores.game2,
        testScore: studentData.scores.test
    };

    try {
        const response = await fetch(SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dataToSend)
        });
        statusEl.textContent = 'ส่งข้อมูลสำเร็จ!';
        statusEl.style.color = 'green';
        clearProgress();
    } catch (error) {
        statusEl.textContent = 'เกิดข้อผิดพลาดในการส่งข้อมูล!';
        statusEl.style.color = 'red';
        submitBtn.disabled = false;
    }
}

// --- Progress Saving & Loading ---
function saveProgress() {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(studentData));
}

function loadProgress() {
    const savedData = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (savedData) {
        const parsedData = JSON.parse(savedData);
        if (parsedData.fullName && confirm('พบข้อมูลการเรียนครั้งก่อน คุณต้องการเรียนต่อหรือไม่?')) {
            studentData = parsedData;
            goToModule(studentData.currentModule |
| 'registration-module');
        } else {
            clearProgress();
            goToModule('registration-module');
        }
    } else {
        goToModule('registration-module');
    }
}

function clearProgress() {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
}
