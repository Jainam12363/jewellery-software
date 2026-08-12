
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

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
    showAuthMessage(loginMessage, 'Please enter username and password.', 'error');
    return;
    }

    setSubmitLoading(loginBtn, true);

    try {
    const data = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
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
