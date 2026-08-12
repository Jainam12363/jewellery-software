
(async () => {
    try {
    await apiRequest('/api/auth/me');
    window.location.href = '/index.html';
    } catch {
    // Not logged in
    }
})();

const registerForm = document.getElementById('registerForm');
const registerMessage = document.getElementById('registerMessage');
const registerBtn = document.getElementById('registerBtn');

registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    registerMessage.hidden = true;

    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    setSubmitLoading(registerBtn, true);

    try {
    const data = await apiRequest('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, email, password, confirmPassword }),
    });
    showAuthMessage(registerMessage, data.message, 'success');
    registerForm.reset();
    setTimeout(() => {
        window.location.href = '/login.html';
    }, 1500);
    } catch (err) {
    showAuthMessage(registerMessage, err.message, 'error');
    } finally {
    setSubmitLoading(registerBtn, false);
    }
});
