const bootstrapData = JSON.parse(document.getElementById('__DASHBOARD_DATA__')?.textContent || '{}');
const state = {
      socket: null,
      activeTab: 'voice',
      selectedChannel: bootstrapData.selectedChannelId || '',
      text: bootstrapData.messages || [],
      isStreaming: false,
      isListening: false,
      audioContextTransmit: null,
      audioContextListen: null,
      processor: null,
      nextStartTime: 0,
      noiseGateHold: 0,
      opusDecoder: null,
      opusDecoderReady: false,
      opusDecodeQueue: [],
    };

    const SAMPLE_RATE = 24000;
    const NOISE_GATE_THRESHOLD = 0.01;
    const NOISE_GATE_HOLD_FRAMES = 3;

    const el = {
      wsDot: document.getElementById('wsDot'),
      wsStatusText: document.getElementById('wsStatusText'),
      activeTabLabel: document.getElementById('activeTabLabel'),
      errorBox: document.getElementById('errorBox'),
      guildSelect: document.getElementById('guildSelect'),
      channelSelect: document.getElementById('channelSelect'),
      channelFilter: document.getElementById('channelFilter'),
      joinVoiceBtn: document.getElementById('joinVoiceBtn'),
      disconnectVoiceBtn: document.getElementById('disconnectVoiceBtn'),
      voiceStatusText: document.getElementById('voiceStatusText'),
      voiceStatusNote: document.getElementById('voiceStatusNote'),
      toggleBtn: document.getElementById('toggleBtn'),
      listenBtn: document.getElementById('listenBtn'),
      listenStatus: document.getElementById('listenStatus'),
      visualizer: document.getElementById('visualizer'),
      userList: document.getElementById('userList'),
      textList: document.getElementById('textList'),
    };

    for (let i = 0; i < 32; i++) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      el.visualizer.appendChild(bar);
    }
    const bars = [...document.querySelectorAll('.bar')];

    async function apiRequest(url, options = {}) {
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(error.message || response.statusText);
      }
      return response.json();
    }

    function showError(message) {
      el.errorBox.textContent = message;
      el.errorBox.style.display = 'block';
      setTimeout(() => { el.errorBox.style.display = 'none'; }, 4500);
    }

    function renderOptions(select, items, placeholder) {
      select.replaceChildren();
      const first = document.createElement('option');
      first.value = '';
      first.textContent = placeholder;
      select.appendChild(first);
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        select.appendChild(option);
      }
    }

    async function loadGuilds() {
      const guilds = bootstrapData.guilds || await apiRequest('/api/guilds');
      renderOptions(el.guildSelect, guilds, 'Select guild');
      const guildId = bootstrapData.selectedGuildId || guilds[0]?.id || '';
      if (guildId) {
        el.guildSelect.value = guildId;
        await loadChannels(guildId);
      }
    }

    async function loadChannels(guildId) {
      const useBootstrap = guildId === bootstrapData.selectedGuildId;
      const [voiceChannels, watchChannels] = await Promise.all([
        useBootstrap && bootstrapData.voiceChannels ? bootstrapData.voiceChannels : apiRequest(`/api/guilds/${guildId}/voice-channels`),
        useBootstrap && bootstrapData.watchChannels ? bootstrapData.watchChannels : apiRequest(`/api/guilds/${guildId}/channels`),
      ]);
      renderOptions(el.channelSelect, voiceChannels, 'Select voice channel');
      renderOptions(el.channelFilter, watchChannels, 'Select channel');
      el.channelFilter.value = state.selectedChannel;
      apiRequest(`/api/guilds/${guildId}/threads`)
        .then((threads) => appendOptions(el.channelFilter, threads))
        .catch((error) => showError(`Thread discovery failed: ${error.message}`));
    }

    function appendOptions(select, items) {
      const existing = new Set([...select.options].map((option) => option.value));
      for (const item of items) {
        if (existing.has(item.id)) continue;
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        select.appendChild(option);
      }
    }

    async function refreshStatus() {
      try {
        const status = await apiRequest('/api/status');
        el.voiceStatusText.textContent = status.connected ? status.activeChannelName || 'Connected' : 'Not connected';
        el.voiceStatusNote.textContent = status.connected ? `Connected to ${status.activeChannelName}` : 'Idle';
      } catch (error) {
        showError(error.message);
      }
    }

    async function connectVoice() {
      const guildId = el.guildSelect.value;
      const channelId = el.channelSelect.value;
      if (!guildId || !channelId) return showError('Select guild and voice channel first');
      const status = await apiRequest('/api/connect', { method: 'POST', body: JSON.stringify({ guildId, channelId }) });
      el.voiceStatusText.textContent = status.activeChannelName || 'Connected';
      el.voiceStatusNote.textContent = `Connected to ${status.activeChannelName}`;
    }

    async function disconnectVoice() {
      await apiRequest('/api/disconnect', { method: 'POST' });
      await refreshStatus();
    }

    function connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      state.socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      state.socket.binaryType = 'arraybuffer';

      state.socket.onopen = () => {
        el.wsDot.classList.add('on');
        el.wsStatusText.textContent = 'Connected';
      };

      state.socket.onclose = () => {
        el.wsDot.classList.remove('on');
        el.wsStatusText.textContent = 'Reconnecting';
        setTimeout(connectWebSocket, 2500);
      };

      state.socket.onerror = () => {
        el.wsDot.classList.remove('on');
        el.wsDot.classList.add('warn');
        el.wsStatusText.textContent = 'Socket error';
      };

      state.socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          handleJsonEvent(event.data);
          return;
        }
        if (!state.isListening) return;
        const bytes = new Uint8Array(event.data);
        if (bytes.byteLength < 5) {
          playPcm(event.data);
          return;
        }
        const mode = bytes[0];
        if (mode === 1) {
          const opusData = bytes.slice(5);
          decodeOpus(opusData);
        } else {
          playPcm(event.data);
        }
      };
    }

    function handleJsonEvent(raw) {
      const message = JSON.parse(raw);
      if (message.type === 'user_state') return renderUsers(message.users || []);
      if (message.type === 'message_created') {
        state.text.unshift(message.data);
        renderText();
      }
      if (message.type === 'message_updated') {
        const item = state.text.find((entry) => entry.id === message.data.id);
        if (item) Object.assign(item, { edited_content: message.data.edited_content, edited_at: message.data.edited_at, type: 'edited' });
        renderText();
      }
      if (message.type === 'message_deleted') {
        const item = state.text.find((entry) => entry.id === message.data.id);
        if (item) Object.assign(item, { deleted_at: message.data.deleted_at, type: 'deleted' });
        renderText();
      }
      if (message.type === 'attachment_uploaded') fetchText();
    }

    function renderUsers(users) {
      el.userList.replaceChildren();
      if (users.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No active speakers';
        el.userList.appendChild(empty);
        return;
      }
      for (const user of users) {
        const row = document.createElement('div');
        row.className = `user-item${user.speaking ? ' speaking' : ''}`;
        const img = document.createElement('img');
        img.src = user.avatar || '';
        img.alt = '';
        const name = document.createElement('span');
        name.textContent = user.username;
        row.append(img, name);
        el.userList.appendChild(row);
      }
    }

    async function fetchText() {
      if (!state.selectedChannel) return renderText();
      const result = await apiRequest(`/api/messages?channel=${encodeURIComponent(state.selectedChannel)}&type=text&limit=80`);
      state.text = result.data || [];
      renderText();
    }

    function parseMetadata(value) {
      if (!value) return {};
      try { return JSON.parse(value); } catch { return {}; }
    }

    function renderText() {
      el.textList.replaceChildren();
      if (!state.selectedChannel) return appendEmpty(el.textList, 'Select channel to view text captures');
      if (state.text.length === 0) return appendEmpty(el.textList, 'No text captures yet');
      for (const msg of state.text) {
        const metadata = parseMetadata(msg.metadata);
        const card = document.createElement('article');
        card.className = 'event-card';
        const head = document.createElement('div');
        head.className = 'event-head';
        const author = document.createElement('div');
        author.className = 'author';
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        if (msg.avatar_url) {
          const img = document.createElement('img');
          img.src = msg.avatar_url;
          img.alt = '';
          avatar.appendChild(img);
        }
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = msg.username || msg.user_id;
        author.append(avatar, name);
        const time = document.createElement('div');
        time.className = 'time';
        time.textContent = new Date(msg.created_at).toLocaleString();
        head.append(author, time);
        const text = document.createElement('div');
        text.className = 'message-text';
        text.textContent = msg.edited_content || msg.content || '(empty message)';
        const stickers = renderStickers(metadata.stickers || []);
        const embeds = renderEmbeds(metadata.embeds || []);
        const attachments = renderAttachments(metadata.attachments || []);
        const badges = document.createElement('div');
        badges.className = 'badges';
        if (metadata.reference?.messageId) appendBadge(badges, 'reply', '');
        if (msg.thread_id) appendBadge(badges, metadata.channel?.threadName ? `thread: ${metadata.channel.threadName}` : 'thread', '');
        if (msg.edited_at) appendBadge(badges, 'edited', 'edit');
        if (msg.deleted_at) appendBadge(badges, 'deleted', 'delete');
        card.append(head, text);
        if (stickers.childElementCount > 0) card.appendChild(stickers);
        if (embeds.childElementCount > 0) card.appendChild(embeds);
        if (attachments.childElementCount > 0) card.appendChild(attachments);
        card.appendChild(badges);
        el.textList.appendChild(card);
      }
    }

    function renderStickers(stickers) {
      const wrap = document.createElement('div');
      wrap.className = 'sticker-strip';
      for (const sticker of stickers) {
        const img = document.createElement('img');
        img.className = 'sticker-img';
        img.src = sticker.url;
        img.alt = sticker.name;
        wrap.appendChild(img);
      }
      return wrap;
    }

    function renderEmbeds(embeds) {
      const wrap = document.createElement('div');
      wrap.className = 'feed';
      for (const embed of embeds) {
        const card = document.createElement('div');
        card.className = 'embed-card';
        if (embed.title) {
          const title = document.createElement(embed.url ? 'a' : 'div');
          title.className = 'embed-title';
          title.textContent = embed.title;
          if (embed.url) {
            title.href = embed.url;
            title.target = '_blank';
            title.rel = 'noreferrer';
          }
          card.appendChild(title);
        }
        if (embed.description) {
          const desc = document.createElement('div');
          desc.className = 'embed-description';
          desc.textContent = embed.description;
          card.appendChild(desc);
        }
        for (const field of embed.fields || []) {
          const fieldNode = document.createElement('div');
          fieldNode.className = 'embed-description';
          fieldNode.textContent = `${field.name}: ${field.value}`;
          card.appendChild(fieldNode);
        }
        if (embed.image || embed.thumbnail) {
          const img = document.createElement('img');
          img.className = 'embed-image';
          img.src = embed.image || embed.thumbnail;
          img.alt = embed.title || 'embed image';
          card.appendChild(img);
        }
        wrap.appendChild(card);
      }
      return wrap;
    }

    function renderAttachments(attachments) {
      const wrap = document.createElement('div');
      wrap.className = 'attachment-strip';
      for (const attachment of attachments) {
        const link = document.createElement('a');
        link.className = 'attachment-chip';
        link.href = attachment.url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = `${attachment.name} (${(attachment.size / 1024).toFixed(1)}KB)`;
        wrap.appendChild(link);
      }
      return wrap;
    }

    function appendBadge(parent, label, className) {
      const badge = document.createElement('span');
      badge.className = `badge ${className}`;
      badge.textContent = label;
      parent.appendChild(badge);
    }

    function appendEmpty(parent, message) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = message;
      parent.appendChild(empty);
    }

    async function startStreaming() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.audioContextTransmit = new AudioContext({ sampleRate: SAMPLE_RATE });
        const source = state.audioContextTransmit.createMediaStreamSource(stream);
        state.processor = state.audioContextTransmit.createScriptProcessor(2048, 1, 1);
        source.connect(state.processor);
        state.processor.connect(state.audioContextTransmit.destination);
        state.processor.onaudioprocess = (event) => {
          if (!state.isStreaming || state.socket?.readyState !== WebSocket.OPEN) return;
          const input = event.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
          const rms = Math.sqrt(sum / input.length);
          if (rms < NOISE_GATE_THRESHOLD && state.noiseGateHold <= 0) return;
          state.noiseGateHold = rms >= NOISE_GATE_THRESHOLD ? NOISE_GATE_HOLD_FRAMES : state.noiseGateHold - 1;
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) pcm[i] = Math.max(-1, Math.min(1, input[i])) * 32767;
          state.socket.send(pcm.buffer);
          updateVisualizer(rms);
        };
        state.isStreaming = true;
        el.toggleBtn.textContent = 'Stop Transmitting';
      } catch (error) {
        showError(`Microphone error: ${error.message}`);
      }
    }

    function stopStreaming() {
      state.isStreaming = false;
      state.processor?.disconnect();
      state.audioContextTransmit?.close();
      state.processor = null;
      state.audioContextTransmit = null;
      el.toggleBtn.textContent = 'Start Transmitting';
      updateVisualizer(0);
    }

    function toggleListen() {
      state.isListening = !state.isListening;
      if (state.isListening) {
        state.audioContextListen = new AudioContext({ sampleRate: 24000 });
        state.nextStartTime = state.audioContextListen.currentTime;
        initOpusDecoder();
        el.listenBtn.textContent = 'Leave Listen Channel';
        el.listenStatus.textContent = 'speaker on';
      } else {
        state.audioContextListen?.close();
        state.audioContextListen = null;
        if (state.opusDecoder) {
          state.opusDecoder.close();
        }
        state.opusDecoder = null;
        state.opusDecoderReady = false;
        state.opusDecodeQueue = [];
        el.listenBtn.textContent = 'Join Listen Channel';
        el.listenStatus.textContent = 'speaker off';
      }
    }

    async function initOpusDecoder() {
      if (!window.AudioDecoder) {
        showError('WebCodecs AudioDecoder not supported in this browser');
        state.isListening = false;
        el.listenBtn.textContent = 'Join Listen Channel';
        el.listenStatus.textContent = 'speaker off';
        return;
      }
      try {
        state.opusDecoder = new AudioDecoder({
          output: (audioData) => playAudioData(audioData),
          error: (error) => {
            console.error('Opus decode error:', error);
            showError(`Opus decode error: ${error.message}`);
          },
        });
        state.opusDecoder.configure({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
        });
        state.opusDecoderReady = true;
        processOpusQueue();
      } catch (error) {
        showError(`Failed to init Opus decoder: ${error.message}`);
        state.isListening = false;
        el.listenBtn.textContent = 'Join Listen Channel';
        el.listenStatus.textContent = 'speaker off';
      }
    }

    function decodeOpus(opusBuffer) {
      if (!state.isListening || !state.opusDecoderReady) {
        if (state.isListening) {
          state.opusDecodeQueue.push(opusBuffer);
        }
        return;
      }
      try {
        const chunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: 0,
          data: opusBuffer,
        });
        state.opusDecoder.decode(chunk);
      } catch (error) {
        console.error('Opus decode chunk error:', error);
      }
    }

    function processOpusQueue() {
      while (state.opusDecodeQueue.length > 0 && state.opusDecoderReady) {
        const buffer = state.opusDecodeQueue.shift();
        decodeOpus(buffer);
      }
    }

    function playAudioData(audioData) {
      if (!state.audioContextListen) {
        audioData.close();
        return;
      }
      try {
        const sampleRate = audioData.sampleRate;
        const frameCount = audioData.numberOfFrames;
        const numberOfChannels = audioData.numberOfChannels;
        const audioBuffer = state.audioContextListen.createBuffer(
          numberOfChannels,
          frameCount,
          sampleRate
        );
        for (let ch = 0; ch < numberOfChannels; ch++) {
          const channelData = audioBuffer.getChannelData(ch);
          const tempArray = new Float32Array(frameCount);
          audioData.copyTo(tempArray, { planeIndex: ch });
          channelData.set(tempArray);
        }
        const source = state.audioContextListen.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(state.audioContextListen.destination);
        const startAt = Math.max(state.nextStartTime, state.audioContextListen.currentTime);
        source.start(startAt);
        state.nextStartTime = startAt + audioBuffer.duration;
      } catch (error) {
        console.error('Play audio error:', error);
      } finally {
        audioData.close();
      }
    }

    function playPcm(arrayBuffer) {
      if (!state.audioContextListen) return;
      const bytes = new Uint8Array(arrayBuffer);
      if (bytes.byteLength <= 4) return;
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset + 4, (bytes.byteLength - 4) / 2);
      const audioBuffer = state.audioContextListen.createBuffer(1, pcm.length, 24000);
      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
      const source = state.audioContextListen.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(state.audioContextListen.destination);
      const startAt = Math.max(state.nextStartTime, state.audioContextListen.currentTime);
      source.start(startAt);
      state.nextStartTime = startAt + audioBuffer.duration;
    }

    function updateVisualizer(level) {
      bars.forEach((bar, index) => {
        const wave = Math.sin(index * 0.55 + Date.now() / 140) * 0.35 + 0.65;
        bar.style.height = `${Math.max(3, level * 190 * wave)}px`;
      });
    }

    document.querySelectorAll('.tab-btn').forEach((button) => {
      button.addEventListener('click', async () => {
        document.querySelectorAll('.tab-btn').forEach((item) => item.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        state.activeTab = button.dataset.tab;
        document.getElementById(state.activeTab).classList.add('active');
        el.activeTabLabel.textContent = button.textContent;
        if (state.activeTab === 'text') await fetchText();
      });
    });

    el.guildSelect.addEventListener('change', () => loadChannels(el.guildSelect.value).catch((error) => showError(error.message)));
    el.joinVoiceBtn.addEventListener('click', () => connectVoice().catch((error) => showError(error.message)));
    el.disconnectVoiceBtn.addEventListener('click', () => disconnectVoice().catch((error) => showError(error.message)));
    el.toggleBtn.addEventListener('click', () => state.isStreaming ? stopStreaming() : startStreaming());
    el.listenBtn.addEventListener('click', toggleListen);
    el.channelFilter.addEventListener('change', async () => {
      state.selectedChannel = el.channelFilter.value;
      const url = new URL(window.location.href);
      if (state.selectedChannel) url.searchParams.set('channel', state.selectedChannel);
      else url.searchParams.delete('channel');
      if (el.guildSelect.value) url.searchParams.set('guild', el.guildSelect.value);
      window.history.replaceState({}, '', url);
      await fetchText().catch((error) => showError(error.message));
    });

    connectWebSocket();
    loadGuilds().then(refreshStatus).catch((error) => showError(error.message));
    setInterval(() => {
      if (state.activeTab === 'text') fetchText().catch(() => {});
    }, 7000);
