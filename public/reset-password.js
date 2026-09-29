// Read token from URL query string
const params = new URLSearchParams(window.location.search);
const resetToken = params.get('token');

const resetForm = document.getElementById('resetForm');
const resetMessage = document.getElementById('resetMessage');
const resetBtn = document.getElementById('resetBtn');

const passwordInput = document.getElementById('password');
const passwordToggle = document.getElementById('passwordToggle');
const confirmPasswordInput = document.getElementById('confirmPassword');
const confirmPasswordToggle = document.getElementById('confirmPasswordToggle');

// Show error immediately if no token present
if (!resetToken) {
  resetForm.style.display = 'none';
  showAuthMessage(
    resetMessage,
    'This password reset link is invalid or has expired. Please request a new one.',
    'error'
  );
}

// Password visibility toggle — New Password
passwordToggle.addEventListener('click', () => {
  const isHidden = passwordInput.type === 'password';
  passwordInput.type = isHidden ? 'text' : 'password';
  passwordToggle.classList.toggle('showing', isHidden);
  passwordToggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  passwordToggle.setAttribute('title', isHidden ? 'Hide password' : 'Show password');
});

// Password visibility toggle — Confirm Password
confirmPasswordToggle.addEventListener('click', () => {
  const isHidden = confirmPasswordInput.type === 'password';
  confirmPasswordInput.type = isHidden ? 'text' : 'password';
  confirmPasswordToggle.classList.toggle('showing', isHidden);
  confirmPasswordToggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  confirmPasswordToggle.setAttribute('title', isHidden ? 'Hide password' : 'Show password');
});

resetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  resetMessage.hidden = true;

  const password = passwordInput.value;
  const confirmPassword = confirmPasswordInput.value;

  if (!password || !confirmPassword) {
    showAuthMessage(resetMessage, 'Please fill in both password fields.', 'error');
    return;
  }

  if (password !== confirmPassword) {
    showAuthMessage(resetMessage, 'Passwords do not match.', 'error');
    return;
  }

  setSubmitLoading(resetBtn, true);

  try {
    const data = await apiRequest('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: resetToken, password, confirmPassword }),
    });
    showAuthMessage(resetMessage, data.message, 'success');
    resetForm.style.display = 'none';
    // Redirect to login after short delay
    setTimeout(() => {
      window.location.href = '/login.html';
    }, 3000);
  } catch (err) {
    showAuthMessage(resetMessage, err.message, 'error');
  } finally {
    setSubmitLoading(resetBtn, false);
  }
});
