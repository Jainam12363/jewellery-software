const forgotForm = document.getElementById('forgotForm');
const forgotMessage = document.getElementById('forgotMessage');
const forgotBtn = document.getElementById('forgotBtn');

forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  forgotMessage.hidden = true;

  const email = document.getElementById('email').value.trim();

  if (!email) {
    showAuthMessage(forgotMessage, 'Please enter your email address.', 'error');
    return;
  }

  setSubmitLoading(forgotBtn, true);

  try {
    const data = await apiRequest('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    showAuthMessage(forgotMessage, data.message, 'success');
    forgotForm.reset();
  } catch (err) {
    showAuthMessage(forgotMessage, err.message, 'error');
  } finally {
    setSubmitLoading(forgotBtn, false);
  }
});
