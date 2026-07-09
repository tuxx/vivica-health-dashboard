// Chat tab: ask questions about today's nutrition data, answered via the /api/chat endpoint
// (server-side call to OpenAI). History is kept in memory only — never persisted to
// localStorage/disk, since transcripts may reference health data.

let chatHistory = []; // [{ role: 'user'|'assistant', content }]
let chatConfigured = null; // null = unknown yet, else boolean

function appendChatMessage(role, text) {
  const emptyState = document.getElementById('chat-empty-state');
  if (emptyState) emptyState.remove();
  const el = document.createElement('div');
  el.className = `chat-bubble chat-bubble-${role}`;
  el.textContent = text;
  $('#chat-messages').appendChild(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

function setChatBusy(busy) {
  $('#chat-input').disabled = busy;
  $('#chat-send').disabled = busy;
}

// Called from showTab() the first time the Chat tab is opened, and again after the AI
// settings panel is saved (see settings.js) so the banner clears without a reload.
async function loadAiChatStatus() {
  try {
    const status = await api('/settings/ai');
    chatConfigured = !!status.configured;
  } catch {
    chatConfigured = false;
  }
  $('#chat-not-configured').classList.toggle('hidden', chatConfigured !== false);
}

$('#chat-open-settings').addEventListener('click', () => showTab('settings'));

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message) return;

  appendChatMessage('user', message);
  chatHistory.push({ role: 'user', content: message });
  input.value = '';
  setChatBusy(true);
  const typingEl = appendChatMessage('assistant', 'Thinking…');
  typingEl.classList.add('chat-bubble-pending');

  try {
    const result = await api('/chat', {
      method: 'POST',
      body: { message, history: chatHistory.slice(-16), date: todayStr() }
    });
    typingEl.remove();
    appendChatMessage('assistant', result.reply || '(no response)');
    chatHistory.push({ role: 'assistant', content: result.reply || '' });
  } catch (err) {
    typingEl.remove();
    if (err.data?.error === 'ai_not_configured') {
      chatConfigured = false;
      $('#chat-not-configured').classList.remove('hidden');
    } else {
      appendChatMessage('assistant', 'Sorry, something went wrong answering that.');
    }
  } finally {
    setChatBusy(false);
    input.focus();
  }
});
