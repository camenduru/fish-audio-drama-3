// agents.js — Fish Audio Agents console: config, tools, knowledge, tests, versions, sessions, phone

import { $, el, toast, modal, close, fish, esc, fmtBytes, fmtTime } from './api.js';
import { openVoicePicker } from './voicepicker.js';
import { attachTagButton } from './tags.js';

const SPEAKING_LANGS = ['en','ja','zh','ko','es','fr','de','pt','it','nl','ar','hi','id','tr','ru','bg','sr','hr','cs','sk','pl','uk','ro','hu','el','sv','da','no','fi','et','lv','lt','ca','he','fa','ur','kk','ka','hy','bn','ta','te','kn','mr','gu','pa','ne','th','vi','ms','tl','af'];
const LLM_MODELS = ['google/gemini-3.5-flash-lite','google/gemini-3.6-flash','google/gemini-2.5-flash','google/gemma-4-26b-a4b-it','anthropic/claude-haiku-4.5','anthropic/claude-sonnet-4.6','openai/gpt-5.6-luna','openai/gpt-4o','openai/gpt-4.1'];
const ASR_MODELS = ['deepgram:nova-3','elevenlabs:scribe_v2_realtime','elevenlabs:scribe_v2_medical'];

const view = { mode: 'list', agentId: null, tab: 'config', agents: [] };

// ---------------------------------------------------------------------------
// small builders
// ---------------------------------------------------------------------------
const f = (label, input, hint) => el('label.field', {}, [el('span', {}, label), input, hint ? el('div.hint', { style: 'margin-top:4px' }, hint) : null]);
const inp = (value, oninput, attrs = {}) => el('input.input', { value: value ?? '', oninput: e => oninput?.(e.target.value), ...attrs });
const sel = (options, value, onchange) => el('select.select', { onchange: e => onchange?.(e.target.value) },
  options.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return el('option', { value: v, selected: v === value }, t); }));
const sw = (label, checked, onchange) => {
  const c = el('input', { type: 'checkbox', checked, onchange: e => onchange?.(e.target.checked) });
  return el('label.switch', { style: 'margin-bottom:10px' }, [c, el('span.track'), label]);
};
const ta = (value, rows, oninput) => el('textarea.textarea.mono', { value: value ?? '', rows, oninput: e => oninput?.(e.target.value) });
// A prompt field with the complex-tag library attached: an agent's first
// message is spoken, so directions and sound tags belong in it too.
const withTags = (field, label) => el('div.flex.aic.gap', {}, [field, attachTagButton(field, { label })]);
const section = (title, children) => el('div.card.mb', {}, [el('div.card-h', {}, title), el('div.card-b', {}, children)]);
const tabBtn = (id, label) => el('div.tab' + (view.tab === id ? '.active' : ''), { onclick: () => { view.tab = id; openAgent(view.agentId, true); } }, label);

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
async function loadAgents() {
  const box = $('#agList');
  box.replaceChildren(el('div.empty', {}, [el('div.big', {}, '⏳'), 'Loading agents…']));
  try {
    const data = await fish.get('v1/agent/agents', { page_size: 50 });
    view.agents = data.agents || [];
    renderList();
  } catch (e) {
    box.replaceChildren(el('div.empty', {}, [el('div.big', {}, '⚠️'), `Could not load agents: ${e.message}`]));
  }
}

function renderList() {
  const q = ($('#agSearch').value || '').toLowerCase();
  const list = view.agents.filter(a => !q || (a.name + a.description).toLowerCase().includes(q));
  const box = $('#agList');
  if (!list.length) {
    box.replaceChildren(el('div.empty', {}, [el('div.big', {}, '🤖'), 'No agents yet. Create one to get started.']));
    return;
  }
  box.replaceChildren(el('div.grid.c2', {}, list.map(a => el('div.tile', { onclick: () => openAgent(a.agent_id) }, [
    el('div.flex.aic.gap.mb', {}, [
      el('span.avatar', {}, '🤖'),
      el('div.grow', {}, [el('h4', {}, a.name),
        el('div.flex.gap', { style: 'margin-top:5px;flex-wrap:wrap' }, [
          el('span.badge' + (a.publication_state === 'live' ? '.green' : '.amber'), {}, a.publication_state),
          a.public_enabled ? el('span.badge.violet', {}, 'public') : null,
          el('span.badge', {}, a.status),
        ])]),
    ]),
    el('p', {}, a.description || 'No description.'),
    el('div.hint.mono', { style: 'margin-top:10px;font-size:10.5px' }, a.agent_id),
  ]))));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
function newAgentModal() {
  const name = inp('', null, { placeholder: 'Support agent' });
  const desc = inp('', null, { placeholder: 'What this agent is for' });
  const prompt = ta('You are a friendly, concise voice assistant. Keep replies short and natural for speech.', 5);
  const voice = inp('b347db033a6549378b48d00acb0d06cd', null, { class: 'input mono' });
  const lang = sel(SPEAKING_LANGS, 'en', null);
  const llm = sel(LLM_MODELS, 'google/gemini-3.6-flash', null);
  const firstMode = sel([['prompt', 'prompt (model decides)'], ['fixed', 'fixed text'], ['off', 'off']], 'prompt', null);
  const firstMsg = inp('Hi! Thanks for calling — how can I help you today?', null);
  const create = el('button.btn.primary', { onclick: async () => {
    if (!name.value.trim()) { toast('Name is required.', 'err'); return; }
    create.disabled = true; create.innerHTML = '<span class="spinner"></span> Creating…';
    try {
      const body = {
        name: name.value.trim(), description: desc.value,
        config: {
          prompt: { system_prompt: prompt.value, first_message_mode: firstMode.value, first_message: firstMsg.value },
          voice: { voice_id: voice.value, speaking_language: lang.value },
          llm: { model: llm.value },
        },
      };
      const a = await fish.post('v1/agent/agents', body);
      toast('Agent created — publish it to go live.', 'ok');
      close(); await loadAgents(); openAgent(a.agent_id);
    } catch (e) { toast('Create failed: ' + e.message, 'err'); }
    finally { create.disabled = false; create.textContent = 'Create agent'; }
  } }, 'Create agent');
  modal({
    title: '＋ New agent', wide: true,
    body: el('div', {}, [
      el('div.row', {}, [f('Name', name), f('Description', desc)]),
      f('System prompt', prompt, 'The agent’s instructions. Keep it speech-friendly.'),
      el('div.row', {}, [f('Voice id', voice), f('Speaking language', lang)]),
      el('div.row', {}, [f('LLM', llm), f('First message mode', firstMode)]),
      f('First message', withTags(firstMsg, 'the first message')),
    ]),
    footer: [el('button.btn', { onclick: close }, 'Cancel'), create],
  });
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
async function openAgent(agentId, keepTab = false) {
  view.mode = 'detail'; view.agentId = agentId;
  if (!keepTab) view.tab = 'config';
  const box = $('#agList');
  box.replaceChildren(el('div.empty', {}, [el('div.big', {}, '⏳'), 'Loading agent…']));
  let agent, config;
  try {
    agent = await fish.get(`v1/agent/agents/${agentId}`);
    config = await fish.get(`v1/agent/agents/${agentId}/config`);
  } catch (e) { box.replaceChildren(el('div.empty', {}, `Failed: ${e.message}`)); return; }

  const head = el('div.flex.aic.gap.mb', {}, [
    el('button.btn.sm', { onclick: () => { view.mode = 'list'; loadAgents(); } }, '← Agents'),
    el('div.grow', {}, [
      el('h2', { style: 'margin:0;font-size:17px' }, agent.name),
      el('div.flex.gap', { style: 'margin-top:6px;flex-wrap:wrap' }, [
        el('span.badge' + (agent.publication_state === 'live' ? '.green' : '.amber'), {}, agent.publication_state),
        el('span.badge', {}, agent.status),
        agent.public_enabled ? el('span.badge.violet', {}, 'public') : null,
      ]),
    ]),
    el('button.btn.sm', { onclick: () => publishModal(agentId, agent) }, '🚀 Publish'),
    el('button.btn.sm.danger', { onclick: () => archiveAgent(agentId, agent) }, agent.status === 'archived' ? 'Unarchive' : 'Archive'),
  ]);

  const tabs = el('div.tabs', { style: 'margin:0 -18px 16px;padding-left:18px' },
    [['config', '⚙️ Config'], ['tools', '🧰 Tools'], ['knowledge', '📚 Knowledge'], ['tests', '🧪 Tests'], ['versions', '🏷 Versions'], ['sessions', '💬 Sessions'], ['webhooks', '🔔 Webhooks'], ['widget', '🧩 Widget'], ['phone', '📞 Phone']].map(([id, l]) => tabBtn(id, l)));

  const panel = el('div', { id: 'agPanel' });
  box.replaceChildren(head, tabs, panel);

  const renderers = { config: renderConfig, tools: renderTools, knowledge: renderKnowledge, tests: renderTests, versions: renderVersions, sessions: renderSessions, webhooks: renderWebhooks, widget: renderWidget, phone: renderPhone };
  await (renderers[view.tab] || renderConfig)(agentId, agent, config, panel);
}

async function archiveAgent(id, agent) {
  try {
    await fish.patch(`v1/agent/agents/${id}`, { status: agent.status === 'archived' ? 'active' : 'archived' });
    toast('Updated.', 'ok'); openAgent(id, true);
  } catch (e) { toast(e.message, 'err'); }
}

function publishModal(id, agent) {
  const title = inp('', null, { placeholder: 'v1' });
  const desc = ta('', 3);
  const go = el('button.btn.primary', { onclick: async () => {
    go.disabled = true; go.innerHTML = '<span class="spinner"></span> Publishing…';
    try {
      const v = await fish.post(`v1/agent/agents/${id}/publish`, { version_title: title.value || undefined, version_description: desc.value || undefined });
      toast('Published version ' + (v.version_number ?? ''), 'ok'); close(); openAgent(id, true);
    } catch (e) { toast('Publish failed: ' + e.message, 'err'); }
    finally { go.disabled = false; go.textContent = 'Publish'; }
  } }, 'Publish');
  modal({ title: '🚀 Publish “' + agent.name + '”', body: el('div', {}, [
    el('div.hint.mb', {}, 'Publishing freezes the current draft into an immutable, numbered version. Live sessions run the published config.'),
    f('Version title', title), f('Version notes', desc),
  ]), footer: [el('button.btn', { onclick: close }, 'Cancel'), go] });
}

// ---------------------------------------------------------------------------
// Tab: config
// ---------------------------------------------------------------------------
async function renderConfig(id, agent, cfg, panel) {
  const p = cfg.prompt || {}, v = cfg.voice || {}, llm = cfg.llm || {}, conv = cfg.conversation || {}, asr = cfg.asr || {}, vars = cfg.variables || {}, gr = cfg.guardrails || {};
  const draft = {};

  const systemPrompt = ta(p.system_prompt || '', 8, x => draft.prompt = { ...draft.prompt, system_prompt: x });
  const firstMode = sel([['prompt', 'prompt'], ['fixed', 'fixed'], ['off', 'off']], p.first_message_mode || 'prompt', x => draft.prompt = { ...draft.prompt, first_message_mode: x });
  const firstMsg = inp(p.first_message || '', x => draft.prompt = { ...draft.prompt, first_message: x });
  const firstPrompt = inp(p.first_message_prompt || '', x => draft.prompt = { ...draft.prompt, first_message_prompt: x });

  const voiceId = inp(v.voice_id || '', x => draft.voice = { ...draft.voice, voice_id: x }, { class: 'input mono' });
  const lang = sel(SPEAKING_LANGS, v.speaking_language || 'en', x => draft.voice = { ...draft.voice, speaking_language: x });
  const voiceRow = el('div.flex.aic.gap', {}, [
    voiceId,
    el('button.btn.sm.icon', {
      title: 'Browse the voice library',
      onclick: () => openVoicePicker((id, title, m) => {
        voiceId.value = id;
        draft.voice = { ...draft.voice, voice_id: id };
        if (m?.languages?.length && SPEAKING_LANGS.includes(m.languages[0])) {
          lang.value = m.languages[0];
          draft.voice = { ...draft.voice, speaking_language: m.languages[0] };
        }
        toast('Agent voice → ' + title, 'ok');
      }, { current: v.voice_id }),
    }, '🔍'),
  ]);
  const speed = el('input', { type: 'range', min: 0.5, max: 2, step: 0.01, value: v.speed ?? 1, oninput: e => { draft.voice = { ...draft.voice, speed: +e.target.value }; $('#agSpeedVal').textContent = (+e.target.value).toFixed(2); } });
  const expressive = sw('Expressive voice', !!v.expressive, x => draft.voice = { ...draft.voice, expressive: x });

  const llmSel = sel(LLM_MODELS, llm.model, x => draft.llm = { model: x });

  const maxDur = inp(conv.max_duration_seconds ?? 1800, x => draft.conversation = { ...draft.conversation, max_duration_seconds: +x }, { type: 'number' });
  const eager = sel(['relaxed', 'balanced', 'eager'], conv.eagerness || 'balanced', x => draft.conversation = { ...draft.conversation, eagerness: x });
  const wait = inp(conv.response_wait_ms ?? 550, x => draft.conversation = { ...draft.conversation, response_wait_ms: +x }, { type: 'number' });
  const interruptible = sw('Interruptible', conv.interruptible !== false, x => draft.conversation = { ...draft.conversation, interruptible: x });
  const record = sw('Record audio', conv.record_audio !== false, x => draft.conversation = { ...draft.conversation, record_audio: x });
  const tz = inp(conv.timezone || '', x => draft.conversation = { ...draft.conversation, timezone: x }, { placeholder: 'Europe/Istanbul' });

  const asrModel = sel(ASR_MODELS, asr.model || 'deepgram:nova-3', x => draft.asr = { ...draft.asr, model: x });
  const multi = sw('Multilingual ASR', !!asr.multilingual, x => draft.asr = { ...draft.asr, multilingual: x });
  const strict = sw('Strict language', !!asr.strict_language, x => draft.asr = { ...draft.asr, strict_language: x });
  const keyterms = inp((asr.keyterms || []).join(', '), x => draft.asr = { ...draft.asr, keyterms: x.split(',').map(s => s.trim()).filter(Boolean) }, { placeholder: 'brand, product, name' });

  const varDefaults = ta(JSON.stringify(vars.defaults || {}, null, 2), 4, x => { try { draft.variables = { ...draft.variables, defaults: JSON.parse(x) }; } catch {} });
  const varMissing = sel(['keep', 'empty', 'reject'], vars.on_missing || 'keep', x => draft.variables = { ...draft.variables, on_missing: x });

  const focus = sw('Guardrail: focus', !!gr.focus, x => draft.guardrails = { ...draft.guardrails, focus: x });
  const manip = sw('Guardrail: anti-manipulation', !!gr.manipulation, x => draft.guardrails = { ...draft.guardrails, manipulation: x });

  panel.replaceChildren(
    section('🪪 Identity', [
      el('div.row', {}, [f('Name', inp(agent.name, null, { oninput: e => draft.name = e.target.value })), f('Description', inp(agent.description || '', null, { oninput: e => draft.description = e.target.value }))]),
      el('div.row', {}, [f('Public', sw('Enabled', !!agent.public_enabled, x => draft.public_enabled = x)), f('Allowed origins', inp((agent.allowed_origins || []).join(', '), null, { oninput: e => draft.allowed_origins = e.target.value.split(',').map(s => s.trim()).filter(Boolean), placeholder: 'https://app.example.com' }))]),
    ]),
    section('🧠 Prompt', [
      f('System prompt', withTags(systemPrompt, 'the system prompt')),
      el('div.row', {}, [f('First message mode', firstMode), f('First message prompt', withTags(firstPrompt, 'the first message prompt'))]),
      f('First message', withTags(firstMsg, 'the first message')),
    ]),
    section('🎙 Voice', [el('div.row', {}, [f('Voice id', voiceRow), f('Speaking language', lang)]),
      el('label.field', {}, [el('span', {}, 'Speed · ', el('b', { id: 'agSpeedVal' }, (+(v.speed ?? 1)).toFixed(2))), speed]), expressive]),
    section('🤖 Model', [f('LLM', llmSel)]),
    section('💬 Conversation', [el('div.row', {}, [f('Max duration (s)', maxDur), f('Response wait (ms)', wait)]),
      f('Eagerness', eager), interruptible, record, f('Timezone', tz)]),
    section('👂 Speech recognition', [f('ASR model', asrModel), multi, strict, f('Keyterms', keyterms, 'Up to 50 words to bias recognition toward.')]),
    section('🔤 Variables', [f('Defaults ({{name}} → value)', varDefaults), f('On missing', varMissing)]),
    section('🛡 Guardrails', [focus, manip]),
    el('div.flex.gap', { style: 'position:sticky;bottom:0;padding:12px 0;background:linear-gradient(transparent,var(--bg) 30%)' }, [
      el('button.btn.primary', { onclick: () => saveConfig(id, draft) }, '💾 Save config'),
      el('button.btn', { onclick: () => openAgent(id, true) }, 'Reset'),
    ]),
  );
}

async function saveConfig(id, draft) {
  try {
    const payload = { ...draft };
    const { name, description, public_enabled, allowed_origins, ...config } = payload;
    if (Object.keys(config).length) await fish.patch(`v1/agent/agents/${id}/config`, config);
    const meta = {};
    if (name !== undefined) meta.name = name;
    if (description !== undefined) meta.description = description;
    if (public_enabled !== undefined) meta.public_enabled = public_enabled;
    if (allowed_origins !== undefined) meta.allowed_origins = allowed_origins;
    if (Object.keys(meta).length) await fish.patch(`v1/agent/agents/${id}`, meta);
    toast('Config saved.', 'ok');
  } catch (e) { toast('Save failed: ' + e.message, 'err'); }
}

// ---------------------------------------------------------------------------
// Tab: tools
// ---------------------------------------------------------------------------
async function renderTools(id, agent, cfg, panel) {
  panel.replaceChildren(el('div.hint', {}, 'Loading tools…'));
  let data = { tools: [] }, all = { tools: [] };
  try { [data, all] = await Promise.all([fish.get('v1/agent/tools'), fish.get(`v1/agent/tools`)]); } catch {}
  const tools = all.tools || [];
  const enabled = cfg.tools?.enabled, attached = cfg.tools?.tool_ids || [];
  const sys = cfg.tools?.system_tools || {};

  const rows = tools.map(t => el('div.list-item', {}, [
    el('div.avatar', {}, t.tool_type === 'webhook' ? '🌐' : '💻'),
    el('div.grow', {}, [el('div.t', {}, t.name), el('div.d.mono.truncate', {}, `${t.method} ${t.url || '(client)'}`)]),
    el('span.badge', {}, t.tool_type),
    el('label.switch', {}, [el('input', { type: 'checkbox', checked: attached.includes(t.tool_id), onchange: async e => {
      try { await fish.patch(`v1/agent/agents/${id}/config`, { tools: { enabled: true, tool_ids: e.target.checked ? [...new Set([...attached, t.tool_id])] : attached.filter(x => x !== t.tool_id) } }); toast('Tool ' + (e.target.checked ? 'attached' : 'detached'), 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    } }), el('span.track')]),
  ]));

  panel.replaceChildren(
    section('🧰 Attached tools', rows.length ? [el('div.list', {}, rows)] : [el('div.hint', {}, 'No tools in this workspace yet.')]),
    section('⚙️ System tools', [
      sw('Hang up call', !!sys.hang_up_call, async x => { try { await fish.patch(`v1/agent/agents/${id}/config`, { tools: { system_tools: { ...sys, hang_up_call: x } } }); toast('Saved', 'ok'); } catch (e) { toast(e.message, 'err'); } }),
      f('Farewell mode', sel(['generated', 'fixed', 'off'], sys.hang_up_call_farewell_mode || 'generated', async x => { try { await fish.patch(`v1/agent/agents/${id}/config`, { tools: { system_tools: { ...sys, hang_up_call_farewell_mode: x } } }); } catch (e) { toast(e.message, 'err'); } })),
      f('Farewell message', inp(sys.hang_up_call_farewell_message || '', null, { onchange: async e => { try { await fish.patch(`v1/agent/agents/${id}/config`, { tools: { system_tools: { ...sys, hang_up_call_farewell_message: e.target.value } } }); } catch (err) { toast(err.message, 'err'); } } })),
    ]),
    el('button.btn.primary', { onclick: () => newToolModal() }, '＋ New tool'),
  );
}

function newToolModal() {
  const name = inp('', null, { placeholder: 'lookup_order' });
  const desc = inp('', null, { placeholder: 'Look up an order by id' });
  const type = sel([['webhook', 'webhook'], ['client', 'client']], 'webhook', x => { urlRow.style.display = x === 'webhook' ? '' : 'none'; });
  const method = sel(['POST', 'GET', 'PUT', 'PATCH', 'DELETE'], 'POST', null);
  const url = inp('', null, { placeholder: 'https://api.example.com/orders' });
  const urlRow = el('div.row', {}, [f('Method', method), f('URL', url)]);
  const expects = sw('Expects a response', true, null);
  const go = el('button.btn.primary', { onclick: async () => {
    go.disabled = true; go.innerHTML = '<span class="spinner"></span>';
    try {
      const body = { name: name.value, description: desc.value, tool_type: type.value, expects_response: expects.querySelector('input').checked };
      if (type.value === 'webhook') { body.method = method.value; body.url = url.value; }
      await fish.post('v1/agent/tools', body);
      toast('Tool created.', 'ok'); close(); openAgent(view.agentId, true);
    } catch (e) { toast('Create failed: ' + e.message, 'err'); }
    finally { go.disabled = false; go.textContent = 'Create tool'; }
  } }, 'Create tool');
  modal({ title: '＋ New tool', body: el('div', {}, [f('Name', name), f('Description', desc), f('Type', type), urlRow, expects]), footer: [el('button.btn', { onclick: close }, 'Cancel'), go] });
}

// ---------------------------------------------------------------------------
// Tab: knowledge
// ---------------------------------------------------------------------------
async function renderKnowledge(id, agent, cfg, panel) {
  panel.replaceChildren(el('div.hint', {}, 'Loading knowledge…'));
  let data = { knowledge_sources: [] };
  try { data = await fish.get('v1/agent/knowledge-sources', { page_size: 50 }); } catch {}
  const sources = data.knowledge_sources || [];
  const attached = cfg.knowledge_base?.knowledge_source_ids || [];
  const rows = sources.map(s => el('div.list-item', {}, [
    el('div.avatar', {}, '📄'),
    el('div.grow', {}, [el('div.t', {}, s.name), el('div.d', {}, `${s.file_name} · ${fmtBytes(s.size_bytes)} · ${s.chunk_count} chunks · rev ${s.revision_number}`)]),
    el('label.switch', {}, [el('input', { type: 'checkbox', checked: attached.includes(s.knowledge_source_id), onchange: async e => {
      try { await fish.patch(`v1/agent/agents/${id}/config`, { knowledge_base: { enabled: true, knowledge_source_ids: e.target.checked ? [...new Set([...attached, s.knowledge_source_id])] : attached.filter(x => x !== s.knowledge_source_id) } }); toast('Updated', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    } }), el('span.track')]),
  ]));
  panel.replaceChildren(
    section('📚 Knowledge base', rows.length ? [el('div.list', {}, rows)] : [el('div.hint', {}, 'No knowledge sources yet.')]),
    el('button.btn.primary', { onclick: () => newKnowledgeModal(id) }, '⬆ Upload source'),
  );
}

function newKnowledgeModal(id) {
  const name = inp('', null, { placeholder: 'Return policy' });
  const desc = inp('', null, { placeholder: 'optional' });
  const file = el('input.input', { type: 'file', accept: '.txt,.md,.pdf,.docx,.csv,.json' });
  const go = el('button.btn.primary', { onclick: async () => {
    if (!file.files[0]) { toast('Pick a file.', 'err'); return; }
    go.disabled = true; go.innerHTML = '<span class="spinner"></span> Uploading…';
    try {
      const fd = new FormData();
      fd.append('source', file.files[0]);
      if (name.value) fd.append('name', name.value);
      fd.append('description', desc.value);
      await fish.post('v1/agent/knowledge-sources', fd);
      toast('Knowledge source added.', 'ok'); close(); openAgent(id, true);
    } catch (e) { toast('Upload failed: ' + e.message, 'err'); }
    finally { go.disabled = false; go.textContent = 'Upload'; }
  } }, 'Upload');
  modal({ title: '⬆ Upload knowledge source', body: el('div', {}, [f('Name', name), f('File', file), f('Description', desc)]), footer: [el('button.btn', { onclick: close }, 'Cancel'), go] });
}

// ---------------------------------------------------------------------------
// Tab: tests
// ---------------------------------------------------------------------------
async function renderTests(id, agent, cfg, panel) {
  panel.replaceChildren(el('div.hint', {}, 'Loading tests…'));
  let data = { tests: [] };
  try { data = await fish.get('v1/agent/tests', { page_size: 50 }); } catch {}
  const tests = (data.tests || []).filter(t => !t.agent_ids?.length || t.agent_ids.includes(id));
  const rows = tests.map(t => el('div.list-item', {}, [
    el('div.avatar', {}, '🧪'),
    el('div.grow', {}, [el('div.t', {}, t.name), el('div.d', {}, t.test_type)]),
    el('button.btn.sm', { onclick: () => runTest(id, t) }, '▶ Run'),
  ]));
  panel.replaceChildren(
    section('🧪 Agent tests', rows.length ? [el('div.list', {}, rows)] : [el('div.hint', {}, 'No tests yet.')]),
    el('div.flex.gap', {}, [
      el('button.btn.primary', { onclick: () => newTestModal(id) }, '＋ New test'),
      el('button.btn', { onclick: () => runTest(id, null) }, '▶ Run all'),
    ]),
    el('div', { id: 'agTestOut' }),
  );
}

async function runTest(id, test) {
  const out = $('#agTestOut');
  out.replaceChildren(el('div.card', {}, [el('div.card-b', {}, [el('span.spinner'), ' Running…'])]));
  try {
    const body = test ? { test_ids: [test.test_id] } : {};
    const res = await fish.post(`v1/agent/agents/${id}/tests/run`, body);
    out.replaceChildren(section('🧾 Result', [el('pre.code', {}, JSON.stringify(res, null, 2))]));
    toast('Test run started.', 'ok');
  } catch (e) { out.replaceChildren(section('🧾 Result', [el('div.hint', {}, 'Run failed: ' + e.message)])); }
}

function newTestModal(id) {
  const name = inp('', null, { placeholder: 'Greets the caller' });
  const type = sel([['next_reply', 'next_reply'], ['tool', 'tool'], ['simulation', 'simulation']], 'next_reply', null);
  const conv = ta('user: Hello\n', 5);
  const expect = inp('', null, { placeholder: 'The agent greets the caller warmly.' });
  const go = el('button.btn.primary', { onclick: async () => {
    go.disabled = true; go.innerHTML = '<span class="spinner"></span>';
    try {
      const body = { name: name.value, test_type: type.value, agent_ids: [id], expectation: expect.value };
      if (type.value !== 'simulation') {
        body.conversation = conv.value.split('\n').filter(Boolean).map(l => { const m = l.match(/^(user|agent|assistant)\s*:\s*(.*)$/i); return { role: (m?.[1] || 'user').toLowerCase().replace('assistant', 'assistant'), content: m?.[2] ?? l }; });
      } else {
        body.simulation = { scenario: expect.value || 'A short test call.', max_turns: 6, success_conditions: [{ description: expect.value || 'Agent behaves correctly.' }] };
      }
      await fish.post('v1/agent/tests', body);
      toast('Test created.', 'ok'); close(); openAgent(id, true);
    } catch (e) { toast('Create failed: ' + e.message, 'err'); }
    finally { go.disabled = false; go.textContent = 'Create test'; }
  } }, 'Create test');
  modal({ title: '＋ New test', body: el('div', {}, [f('Name', name), f('Type', type), f('Conversation (user:/agent:)', conv), f('Expectation', expect)]), footer: [el('button.btn', { onclick: close }, 'Cancel'), go] });
}

// ---------------------------------------------------------------------------
// Tab: versions
// ---------------------------------------------------------------------------
async function renderVersions(id, agent, cfg, panel) {
  panel.replaceChildren(el('div.hint', {}, 'Loading versions…'));
  try {
    const data = await fish.get(`v1/agent/agents/${id}/versions`);
    const vs = data.versions || [];
    panel.replaceChildren(section('🏷 Published versions', vs.length ? [el('div.list', {}, vs.map(v => el('div.list-item', {}, [
      el('div.avatar', {}, '🏷'),
      el('div.grow', {}, [el('div.t', {}, `v${v.version_number} · ${v.version_title || 'untitled'}`), el('div.d', {}, `${fmtTime(v.published_at)} · ${v.config_hash?.slice(0, 10) || ''}`)]),
      el('span.badge.green', {}, 'live'),
    ])))] : [el('div.hint', {}, 'No published versions yet.')]));
  } catch (e) { panel.replaceChildren(section('🏷 Versions', [el('div.hint', {}, e.message)])); }
}

// ---------------------------------------------------------------------------
// Tab: sessions
// ---------------------------------------------------------------------------
async function renderSessions(id, agent, cfg, panel) {
  panel.replaceChildren(el('div.hint', {}, 'Loading sessions…'));
  try {
    const data = await fish.get('v1/agent/sessions', { agent_id: id, page_size: 30 });
    const ss = data.sessions || [];
    panel.replaceChildren(section('💬 Recent sessions', ss.length ? [el('div.list', {}, ss.map(s => el('div.list-item', { onclick: () => openSession(s.session_id) }, [
      el('div.avatar', {}, s.source === 'phone' ? '📞' : '💬'),
      el('div.grow', {}, [el('div.t', {}, s.name || s.session_id.slice(0, 14)), el('div.d', {}, `${s.status} · ${s.duration_seconds ?? '—'}s · ${fmtTime(s.created_at)}`)]),
      el('span.badge', {}, s.source),
    ])))] : [el('div.hint', {}, 'No sessions yet.')]));
  } catch (e) { panel.replaceChildren(section('💬 Sessions', [el('div.hint', {}, e.message)])); }
}

async function openSession(sid) {
  const body = el('div', {}, [el('div.hint', {}, 'Loading transcript…')]);
  modal({ title: '💬 Session ' + sid.slice(0, 12), body, wide: true });
  try {
    const s = await fish.get(`v1/agent/sessions/${sid}`);
    const msgs = s.messages || [];
    const calls = s.tool_calls || s.tool_results || [];
    body.replaceChildren(
      el('div.kv', {}, [el('span.k', {}, 'Status'), el('span.v', {}, `${s.status} · ${s.end_reason || ''}`)]),
      el('div.kv', {}, [el('span.k', {}, 'Duration'), el('span.v', {}, (s.duration_seconds ?? '—') + ' s')]),
      el('div.kv.mb', {}, [el('span.k', {}, 'Agent'), el('span.v', {}, s.agent_name || s.agent_id)]),
      el('div.chat.mt', {}, msgs.map(m => el('div.bubble.' + (m.role === 'user' ? 'user' : 'agent'), {}, m.content))),
      calls.length ? el('div.mt', {}, [el('div.hint.mb', {}, 'Tool calls'), ...calls.map(c => el('div.bubble.tool', {}, `${c.tool_name}: ${String(c.input || '').slice(0, 200)}`))]) : null,
      s.analysis ? section('📊 Post-call analysis', [el('pre.code', {}, JSON.stringify(s.analysis, null, 2))]) : null,
      el('button.btn.sm.mt', { onclick: () => { window.open(`/api/fish/v1/agent/sessions/${sid}/recording`, '_blank'); } }, '⬇ Recording'),
    );
  } catch (e) { body.replaceChildren(el('div.hint', {}, 'Failed: ' + e.message)); }
}

// ---------------------------------------------------------------------------
// Tab: webhooks
// ---------------------------------------------------------------------------
async function renderWebhooks(id, agent, cfg, panel) {
  const w = cfg.webhooks || {};
  const init = w.conversation_init || {};
  const posts = w.post_call || [];
  const initUrl = inp(init.url || '', null, { placeholder: 'https://your.app/hooks/init' });
  const initSecret = inp(init.secret || '', null, { placeholder: 'shared secret' });
  const save = el('button.btn.primary', { onclick: async () => {
    try { await fish.patch(`v1/agent/agents/${id}/config`, { webhooks: { conversation_init: initUrl.value ? { url: initUrl.value, secret: initSecret.value || null, timeout_seconds: 10 } : null } }); toast('Saved', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  } }, '💾 Save');
  panel.replaceChildren(
    section('🔔 Conversation-init webhook', [el('div.hint.mb', {}, 'Called when a session starts — you can inject dynamic variables.'), f('URL', initUrl), f('Secret', initSecret), save]),
    section('📤 Post-call webhooks', [
      el('div.hint.mb', {}, 'Fired after a call ends with the transcript, analysis and recording reference.'),
      ...(posts.length ? posts.map(p => el('div.kv', {}, [el('span.k', {}, 'URL'), el('span.v.mono', {}, p.url)])) : [el('div.hint', {}, 'None configured.')]),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Tab: widget
// ---------------------------------------------------------------------------
async function renderWidget(id, agent, cfg, panel) {
  panel.replaceChildren(el('div.hint', {}, 'Loading widget…'));
  try {
    const w = await fish.get(`v1/agent/agents/${id}/widget`);
    const embed = `<script src="https://unpkg.com/@fishaudio/agent-widget"><\/script>\n<fish-agent agent-id="${id}"></fish-agent>`;
    panel.replaceChildren(section('🧩 Embeddable widget', [
      el('div.kv', {}, [el('span.k', {}, 'Agent name'), el('span.v', {}, w.agent_name)]),
      el('div.hint.mb', {}, 'Drop this into any page to give visitors a voice chat with the agent.'),
      el('pre.code', {}, embed),
      el('button.btn.sm.mt', { onclick: () => { navigator.clipboard?.writeText(embed); toast('Copied'); } }, '⧉ Copy embed'),
    ]));
  } catch (e) { panel.replaceChildren(section('🧩 Widget', [el('div.hint', {}, e.message)])); }
}

// ---------------------------------------------------------------------------
// Tab: phone
// ---------------------------------------------------------------------------
async function renderPhone(id, agent, cfg, panel) {
  panel.replaceChildren(el('div.hint', {}, 'Loading numbers…'));
  let nums = { phone_numbers: [] }, avail = { phone_numbers: [] };
  try { [nums, avail] = await Promise.all([fish.get('v1/agent/phone-numbers'), fish.get('v1/agent/available-phone-numbers')]); } catch {}
  const list = nums.phone_numbers || [];
  panel.replaceChildren(
    section('📞 Your numbers', list.length ? [el('div.list', {}, list.map(n => el('div.list-item', {}, [
      el('div.avatar', {}, '📞'),
      el('div.grow', {}, [el('div.t.mono', {}, n.phone_number), el('div.d', {}, `${n.provider} · ${n.status}${n.agent_id ? ' · bound' : ''}`)]),
      el('button.btn.sm', { onclick: async () => { try { await fish.patch(`v1/agent/phone-numbers/${n.phone_number_id}`, { agent_id: id }); toast('Bound to agent', 'ok'); openAgent(id, true); } catch (e) { toast(e.message, 'err'); } } }, 'Bind'),
    ])))] : [el('div.hint', {}, 'No phone numbers.')]),
    section('🌐 Available numbers', (avail.available_phone_numbers || avail.phone_numbers || []).length ? [el('div.list', {}, (avail.available_phone_numbers || avail.phone_numbers || []).slice(0, 20).map(n => el('div.list-item', {}, [
      el('div.grow', {}, [el('div.t.mono', {}, n.phone_number || n.number || JSON.stringify(n).slice(0, 40))]),
      el('button.btn.sm', { onclick: () => purchaseNumber(n, id) }, 'Buy'),
    ])))] : [el('div.hint', {}, 'No numbers available for this workspace.')]),
  );
}

async function purchaseNumber(n, id) {
  try {
    await fish.post('v1/agent/phone-numbers', { provider: n.provider || 'livekit', phone_number: n.phone_number || n.number, label: '', agent_id: id });
    toast('Number purchased.', 'ok'); openAgent(id, true);
  } catch (e) { toast('Purchase failed: ' + e.message, 'err'); }
}

// ---------------------------------------------------------------------------
export function initAgents() {
  $('#agRefresh').addEventListener('click', loadAgents);
  $('#agNew').addEventListener('click', newAgentModal);
  $('#agSearch').addEventListener('input', () => { if (view.mode === 'list') renderList(); });
  loadAgents();
}

export { loadAgents };
