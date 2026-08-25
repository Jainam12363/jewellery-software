
(async () => {
    try {
    await apiRequest('/api/auth/me');
    window.location.href = '/index.html';
    } catch {
    // Not logged in — stay on login page
    }
})();

const loginForm = document.getElementById('loginForm');
const loginMessage = document.getElementById('loginMessage');
const loginBtn = document.getElementById('loginBtn');

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginMessage.hidden = true;

    const identifier = document.getElementById('identifier').value.trim();
    const password = document.getElementById('password').value;

    if (!identifier || !password) {
    showAuthMessage(loginMessage, 'Please enter username/email and password.', 'error');
    return;
    }

    setSubmitLoading(loginBtn, true);

    try {
    const data = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
    });
    currentUser = data.user;
    csrfToken = data.csrfToken;
    window.location.href = '/index.html';
    } catch (err) {
    showAuthMessage(loginMessage, err.message, 'error');
    } finally {
    setSubmitLoading(loginBtn, false);
    }
});
