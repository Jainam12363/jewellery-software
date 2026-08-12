let csrfToken = null;
let currentUser = null;

async function apiRequest(url, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };

  if (csrfToken && options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
  });

  let data = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await response.json();
  }

  if (!response.ok) {
    const error = new Error(data?.error || 'Something went wrong.');
    error.status = response.status;
    throw error;
  }

  return data;
}

async function requireAuth() {
  try {
    const data = await apiRequest('/api/auth/me');
    currentUser = data.user;
    csrfToken = data.csrfToken;
    return true;
  } catch {
    window.location.href = '/login.html';
    return false;
  }
}

async function logout() {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
  } catch {
    // Still redirect even if logout request fails
  }
  window.location.href = '/login.html';
}

function showAuthMessage(el, text, type) {
  el.textContent = text;
  el.className = `message ${type}`;
  el.hidden = false;
}

function setSubmitLoading(button, loading) {
  button.disabled = loading;
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.textContent = loading ? 'Please wait…' : button.dataset.originalText;
}
