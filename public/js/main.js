// State
let currentConfig = null;
let currentConfigName = null;
let token = localStorage.getItem('token');
let currentUser = null;

// --- API layer: single place that understands the {success,data,error} envelope ---
async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        /* non-JSON response (proxy error page, etc.) */
    }

    if (response.status === 401) {
        handleLogout();
        throw new Error('Session expired. Please log in again.');
    }
    if (!response.ok) {
        const message =
            (payload && payload.error && payload.error.message) ||
            `Request failed (${response.status})`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }
    return payload ? payload.data : null;
}

// Initial setup
document.addEventListener('DOMContentLoaded', () => {
    if (token) showDashboard();
});

// Static listeners
document.getElementById('loginForm').addEventListener('submit', handleLogin);
document.getElementById('logoutBtn').addEventListener('click', handleLogout);
document.getElementById('addClientBtn').addEventListener('click', () => showModal('addClientModal'));
document.getElementById('addClientForm').addEventListener('submit', handleAddClient);
document.getElementById('usePassword').addEventListener('change', (e) => {
    const row = document.getElementById('clientPasswordRow');
    const input = document.getElementById('clientPassword');
    row.classList.toggle('hidden', !e.target.checked);
    input.required = e.target.checked;
    if (!e.target.checked) input.value = '';
});

// Delegated actions (replaces inline onclick attributes; CSP-safe)
document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, modal, client, user } = button.dataset;
    if (action === 'close-modal') closeModal(modal);
    else if (action === 'download-config') downloadConfig();
    else if (action === 'config') showClientConfig(client);
    else if (action === 'delete-client') deleteClient(client);
    else if (action === 'reset-password') resetUserPassword(user);
    else if (action === 'delete-user') deleteUser(user);
});

// --- Authentication ---
async function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    try {
        const data = await api('/api/login', { method: 'POST', body: { username, password } });
        token = data.token;
        localStorage.setItem('token', token);
        showDashboard();
    } catch (error) {
        alert('Login failed: ' + error.message);
    }
}

function handleLogout() {
    localStorage.removeItem('token');
    token = null;
    currentUser = null;
    showLogin();
}

// --- UI control ---
function showDashboard() {
    document.getElementById('loginSection').classList.add('hidden');
    document.getElementById('dashboardSection').classList.remove('hidden');
    loadClients();
    checkAdminStatus();
}

function showLogin() {
    document.getElementById('dashboardSection').classList.add('hidden');
    document.getElementById('loginSection').classList.remove('hidden');
}

function showModal(modalId) {
    const modal = document.getElementById(modalId);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function actionButton(label, action, datasetKey, value, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.dataset[datasetKey] = value;
    button.className = className;
    button.textContent = label;
    return button;
}

// --- Clients ---
async function loadClients() {
    try {
        const data = await api('/api/clients');
        const list = document.getElementById('clientsList');
        list.replaceChildren();

        for (const client of data.clients) {
            const row = document.createElement('tr');

            const nameCell = document.createElement('td');
            nameCell.className = 'px-6 py-4 whitespace-nowrap';
            nameCell.textContent = client.name;
            if (client.status && client.status !== 'valid') {
                const badge = document.createElement('span');
                badge.className = 'ml-2 text-xs uppercase text-gray-500';
                badge.textContent = `(${client.status})`;
                nameCell.appendChild(badge);
            }

            const actionsCell = document.createElement('td');
            actionsCell.className = 'px-6 py-4 whitespace-nowrap';
            if (client.status !== 'revoked') {
                actionsCell.appendChild(
                    actionButton('Config', 'config', 'client', client.name, 'text-blue-500 hover:text-blue-700 mr-4')
                );
            }
            actionsCell.appendChild(
                actionButton('Delete', 'delete-client', 'client', client.name, 'text-red-500 hover:text-red-700')
            );

            row.append(nameCell, actionsCell);
            list.appendChild(row);
        }
    } catch (error) {
        alert('Error loading clients: ' + error.message);
    }
}

async function handleAddClient(event) {
    event.preventDefault();
    const clientName = document.getElementById('clientName').value.trim();
    const usePassword = document.getElementById('usePassword').checked;
    const password = document.getElementById('clientPassword').value;

    try {
        const created = await api('/api/clients', {
            method: 'POST',
            body: { clientName, usePassword, ...(usePassword ? { password } : {}) },
        });
        document.getElementById('addClientForm').reset();
        document.getElementById('clientPasswordRow').classList.add('hidden');
        closeModal('addClientModal');
        await showClientConfig(created.clientName);
        loadClients();
    } catch (error) {
        alert('Error creating client: ' + error.message);
    }
}

async function deleteClient(clientName) {
    if (!confirm(`Are you sure you want to revoke client "${clientName}"?`)) return;
    try {
        await api(`/api/clients/${encodeURIComponent(clientName)}`, { method: 'DELETE' });
        loadClients();
    } catch (error) {
        alert('Error deleting client: ' + error.message);
    }
}

async function showClientConfig(clientName) {
    try {
        const data = await api(`/api/clients/${encodeURIComponent(clientName)}/config`);
        currentConfig = data.config;
        currentConfigName = data.clientName;
        document.getElementById('cname').textContent = `Client Config: ${data.clientName}`;
        // textContent only — profile text is never interpreted as HTML.
        document.getElementById('configContent').textContent = data.config;
        showModal('configModal');
    } catch (error) {
        alert('Error getting client config: ' + error.message);
    }
}

function downloadConfig() {
    if (!currentConfig) return;
    const blob = new Blob([currentConfig], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentConfigName ? `${currentConfigName}.ovpn` : 'client.ovpn';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

// --- Admin: users ---
async function checkAdminStatus() {
    try {
        const me = await api('/api/users/me');
        currentUser = me.username;
        document.getElementById('userDisplay').textContent = `${me.username} (${me.role})`;
        if (me.role === 'admin') {
            document.getElementById('adminSection').classList.remove('hidden');
            loadUsers();
        } else {
            document.getElementById('adminSection').classList.add('hidden');
        }
    } catch (error) {
        console.error('Error checking admin status:', error);
    }
}

async function loadUsers() {
    try {
        const data = await api('/api/users');
        const list = document.getElementById('usersList');
        list.replaceChildren();

        for (const user of data.users) {
            const row = document.createElement('tr');

            const usernameCell = document.createElement('td');
            usernameCell.className = 'px-6 py-4 whitespace-nowrap';
            usernameCell.textContent = user.username;

            const roleCell = document.createElement('td');
            roleCell.className = 'px-6 py-4 whitespace-nowrap';
            roleCell.textContent = user.role;

            const lastLoginCell = document.createElement('td');
            lastLoginCell.className = 'px-6 py-4 whitespace-nowrap';
            lastLoginCell.textContent = formatDate(user.lastLogin);

            const actionsCell = document.createElement('td');
            actionsCell.className = 'px-6 py-4 whitespace-nowrap';
            actionsCell.appendChild(
                actionButton('Reset Password', 'reset-password', 'user', user.username, 'text-yellow-500 hover:text-yellow-700 mr-2')
            );
            if (user.username !== currentUser) {
                actionsCell.appendChild(
                    actionButton('Delete', 'delete-user', 'user', user.username, 'text-red-500 hover:text-red-700')
                );
            }

            row.append(usernameCell, roleCell, lastLoginCell, actionsCell);
            list.appendChild(row);
        }
    } catch (error) {
        alert('Error loading users: ' + error.message);
    }
}

async function deleteUser(username) {
    if (!confirm(`Are you sure you want to delete user "${username}"?`)) return;
    try {
        await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        loadUsers();
    } catch (error) {
        alert('Error deleting user: ' + error.message);
    }
}

async function resetUserPassword(username) {
    const newPassword = prompt(`Enter new password for user "${username}" (at least 8 characters)`);
    if (!newPassword) return;
    if (newPassword.length < 8) {
        alert('Password must be at least 8 characters.');
        return;
    }
    try {
        await api(`/api/users/${encodeURIComponent(username)}/reset-password`, {
            method: 'POST',
            body: { password: newPassword },
        });
        alert('Password reset successfully');
        loadUsers();
    } catch (error) {
        alert('Error resetting password: ' + error.message);
    }
}

// --- Utilities ---
function formatDate(dateString) {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleString();
}

window.onerror = function (message, source, lineno, colno, error) {
    console.error('Global error:', { message, source, lineno, colno, error });
    return false;
};
