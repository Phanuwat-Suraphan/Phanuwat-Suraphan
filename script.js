// === State Management ===
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyX3nPERkuk2SPTvkxIuq9UEAln7o0-phVoUPIf_Y8KnhxErvaoMKA-Z8i6bksVuaCUWA/exec';
const LOCAL_STORAGE_KEY = 'squareRootQuestProgress';

let studentData = {
    fullName: '',
    studentId: '',
    studentClass: '',
    exercise1Score: 0,
    exercise2Score: 0,
    game1Score: 0,
    game2Score: 0,
    testScore: 0,
    currentModule: 'registration-module' // Track the current module
};

// === Progress Saving & Loading (NEW) ===
function saveProgress() {
    // Save the current student data to the browser's local storage
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(studentData));
}

function loadProgress() {
    const savedData = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (savedData) {
        const parsedData = JSON.parse(savedData);
        // Check if there's valid saved data
        if (parsedData.fullName && parsedData.studentId) {
            if (confirm('พบข้อมูลการเรียนครั้งก่อน คุณต้องการเรียนต่อหรือไม่? (หากไม่ต้องการ ข้อมูลเดิมจะถูกลบ)')) {
                studentData = parsedData;
                updateSummaryDisplay(); // Update summary display in case they jump there
                goToModule(studentData.currentModule);
            } else {
                // If user chooses not to continue, clear the old data
                localStorage.removeItem(LOCAL_STORAGE_KEY);
                goToModule('registration-module');
            }
        }
    } else {
        // No saved data, start from the beginning
        goToModule('registration-module');
    }
}

function clearProgress() {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
}

// === UI Control ===
document.getElementById('registration-form').addEventListener('submit', function(e) {
    e.preventDefault();
    studentData.fullName = document.getElementById('fullName').value;
    studentData.studentId = document.getElementById('studentId').value;
    studentData.studentClass = document.getElementById('studentClass').value;

    // Move to the first content module and save progress
    goToModule('content-module-1');
});

function goToModule(moduleId) {
    document.querySelectorAll('.module').forEach(module => {
        module.classList.remove('active');
    });
    document.getElementById(moduleId).classList.add('active');

    // Update and save the current location
    studentData.currentModule = moduleId;
    if (studentData.fullName) { // Only save if registration is complete
        saveProgress();
    }
}

// Dummy function to simulate completing a task, updating score, and moving to the next module
function completeAndGoTo(scoreKey, scoreValue, nextModule) {
    studentData[scoreKey] = scoreValue;
    // In a real app, you might also update other scores here
    studentData.testScore = 85; // dummy data
    studentData.game1Score = 7500; // dummy data
    updateSummaryDisplay();
    goToModule(nextModule);
}

function updateSummaryDisplay() {
    document.getElementById('summary-ex1').innerText = studentData.exercise1Score;
    document.getElementById('summary-ex2').innerText = studentData.exercise2Score;
    document.getElementById('summary-game1').innerText = studentData.game1Score;
    document.getElementById('summary-game2').innerText = studentData.game2Score;
    document.getElementById('summary-test').innerText = studentData.testScore;
}

// === Data Submission ===
async function submitData() {
    const submitBtn = document.getElementById('submit-scores-btn');
    const statusEl = document.getElementById('submission-status');

    submitBtn.disabled = true;
    statusEl.innerText = 'กำลังส่งข้อมูล...';
    statusEl.style.color = 'orange';

    try {
        const response = await fetch(SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(studentData)
        });

        statusEl.innerText = 'ส่งข้อมูลสำเร็จ!';
        statusEl.style.color = 'green';
        console.log('Data submission initiated.');
        clearProgress(); // Clear saved data after successful submission

    } catch (error) {
        statusEl.innerText = 'เกิดข้อผิดพลาดในการส่งข้อมูล! กรุณาลองใหม่อีกครั้ง';
        statusEl.style.color = 'red';
        submitBtn.disabled = false;
        console.error('Error submitting data:', error);
    }
}

// === App Initialization ===
// When the page loads, check for saved progress.
window.addEventListener('load', loadProgress);