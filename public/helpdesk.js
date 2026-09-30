/**
 * Help desk, presented as a chat.
 *
 * ## What this is, and what it is not
 *
 * It looks like a live-agent widget because that is the shape people arrive expecting, and a
 * support request from someone who is mid-problem is easier to write in a conversation than in
 * a four-field form. It is not a live agent, and it does not pretend to be one. There is no
 * agent on the other end typing back, so the UI does not show a typing indicator that resolves
 * into nothing, does not show a green "online" dot, and does not imply a reply is seconds away.
 * A visitor who is told an agent is typing and then waits ten minutes has been lied to, and on a
 * payments site that is a bad way to lose trust over a support form.
 *
 * So: a chat-shaped transcript, honest about the channel. The opening line states the response
 * time, the send confirmation names the address the answer goes to, and the composer stays
 * available after sending so the thread can be continued. The message goes through the same
 * `/api/contact` endpoint the email form uses, with the same validation, so there is one
 * delivery path and one place where a support request can fail.
 *
 * ## One copy, injected
 *
 * The dialog is built here and appended to `document.body` rather than pasted into twelve
 * pages. Twelve copies of this markup would be twelve copies to keep in step, and the earlier
 * contact dialog already showed how that goes: a page that carries a `data-contact-trigger`
 * link but not the dialog is a link that silently does nothing. Building it in one place means
 * the trigger and the thing it opens can never come apart.
 *
 * The trigger is `data-helpdesk-trigger`, deliberately distinct from the existing
 * `data-contact-trigger`. "Help desk" and "Contact support" are two different affordances --
 * one is a conversation, one is the email form -- and pointing both at the same dialog makes
 * two links that look different and do the same thing.
 */
(function () {
    'use strict';

    const DIALOG_ID = 'helpdesk-dialog';
    const AGENT_NAME = 'RewardZone Support';

    /* The composer's growth cap. Matches the `max-height` on `.helpdesk-input`; the script has
     * to know it because it writes an inline height that would otherwise win over the
     * stylesheet. The base height is CSS's job and is deliberately not repeated here. */
    const COMPOSER_MAX = 120;

    /**
     * Opening topics, as chips under the first message.
     *
     * These are the four things that actually arrive, and a chip does two jobs: it saves
     * someone typing "my deposit says complete but my balance has not changed", and it puts
     * the wording support actually searches for into the subject line. A chip only fills the
     * composer -- it never sends. A one-tap send would be the fastest possible way to file a
     * ticket the person did not mean to file.
     */
    const TOPICS = [
        {
            label: 'A deposit is missing',
            subject: 'Deposit not credited',
            prompt: 'My deposit shows as complete but my balance has not changed. '
        },
        {
            label: 'My withdrawal is pending',
            subject: 'Withdrawal status',
            prompt: 'I would like an update on my withdrawal request. '
        },
        {
            label: 'A question about an offer',
            subject: 'Question about an offer',
            prompt: 'I have a question about one of the offers: '
        },
        {
            label: 'Something else',
            subject: 'Support request',
            prompt: ''
        }
    ];

    let dialog = null;
    let thread = null;
    let composer = null;
    let sendButton = null;
    let statusLine = null;
    let submitting = false;
    let wired = false;

    /**
     * Builds the dialog once. Returns the existing element on later calls, so a page that
     * somehow has two triggers still opens one dialog.
     */
    function ensureDialog() {
        const existing = document.getElementById(DIALOG_ID);
        if (existing) return existing;

        const topics = TOPICS.map((topic, index) => `
            <button type="button" class="helpdesk-chip" data-topic="${index}">${escapeHtml(topic.label)}</button>
        `).join('');

        const element = document.createElement('dialog');
        element.className = 'dialog dialog-helpdesk';
        element.id = DIALOG_ID;
        element.setAttribute('aria-labelledby', 'helpdesk-title');
        element.innerHTML = `
            <div class="dialog-panel helpdesk-panel">
                <div class="dialog-heading helpdesk-heading">
                    <div class="helpdesk-agent">
                        <span class="helpdesk-avatar" aria-hidden="true">RZ</span>
                        <div class="helpdesk-agent-text">
                            <h2 id="helpdesk-title">${escapeHtml(AGENT_NAME)}</h2>
                            <p class="helpdesk-presence" id="helpdesk-presence">Replies by email, usually within one business day</p>
                        </div>
                    </div>
                    <button class="icon-button" type="button" data-helpdesk-close aria-label="Close the help desk">&times;</button>
                </div>

                <div class="helpdesk-thread" id="helpdesk-thread" role="log" aria-live="polite" aria-label="Conversation with support"></div>

                <!-- The identity block is built by buildIdentityBlock() below rather than
                     written here, so that resetThread() can rebuild the one a send removes
                     without this template and that function holding two copies of it. -->

                <form class="helpdesk-composer" id="helpdesk-form" novalidate>
                    <!-- Not shown to a visitor who is only reading the thread; the same words
                         are already on screen in the presence line. It is for a screen reader,
                         which reads the transcript aloud and needs to know who is speaking. -->
                    <label class="visually-hidden" for="helpdesk-message">Your message to support</label>
                    <textarea class="form-input helpdesk-input" id="helpdesk-message" name="message" rows="1"
                              maxlength="2000" placeholder="Describe what happened&hellip;"
                              aria-describedby="helpdesk-count"></textarea>
                    <div class="helpdesk-actions">
                        <span class="field-count" id="helpdesk-count" aria-live="polite"></span>
                        <button class="button button-accent" id="helpdesk-send" type="submit">Send</button>
                    </div>
                    <p class="helpdesk-status" id="helpdesk-status" role="status" aria-live="polite"></p>
                </form>
            </div>
        `;

        document.body.appendChild(element);
        return element;
    }

    /**
     * Appends a message to the transcript.
     *
     * `role="log"` on the thread means assistive technology announces additions without
     * stealing focus, which is what a conversation needs: the user is typing, and an
     * announcement should not move the caret.
     */
    function addMessage(role, text) {
        if (!thread) return;
        const bubble = document.createElement('div');
        bubble.className = `helpdesk-message is-${role}`;
        const who = document.createElement('p');
        who.className = 'helpdesk-message-who';
        who.textContent = role === 'you' ? 'You' : AGENT_NAME;
        const body = document.createElement('p');
        body.className = 'helpdesk-message-body';
        body.textContent = text;
        bubble.append(who, body);
        thread.appendChild(bubble);
        thread.scrollTop = thread.scrollHeight;
    }

    function addTopicChips() {
        if (!thread) return;
        const row = document.createElement('div');
        row.className = 'helpdesk-topics';
        const label = document.createElement('p');
        label.className = 'helpdesk-topics-label';
        label.id = 'helpdesk-topics-label';
        label.textContent = 'Common questions';
        row.appendChild(label);
        for (const [index, topic] of TOPICS.entries()) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'helpdesk-chip';
            chip.dataset.topic = String(index);
            chip.textContent = topic.label;
            row.appendChild(chip);
        }
        thread.appendChild(row);
        thread.scrollTop = thread.scrollHeight;
    }

    function setStatus(text, tone) {
        if (!statusLine) return;
        statusLine.textContent = text || '';
        statusLine.className = `helpdesk-status${tone ? ` is-${tone}` : ''}`;
    }

    function setBusy(busy) {
        submitting = busy;
        if (sendButton) {
            sendButton.disabled = busy;
            sendButton.textContent = busy ? 'Sending...' : 'Send';
        }
        if (composer) composer.disabled = busy;
        for (const chip of document.querySelectorAll('.helpdesk-chip')) chip.disabled = busy;
    }

    function updateCount() {
        if (!composer) return;
        const counter = document.getElementById('helpdesk-count');
        if (!counter) return;
        const limit = composer.maxLength || 0;
        if (limit === 0) return;
        const remaining = limit - composer.value.length;
        counter.textContent = remaining <= 0
            ? 'Message is full'
            : `${remaining} characters left`;
        counter.classList.toggle('is-warning', remaining > 0 && remaining <= 200);
    }

    /**
     * Grows the composer only when what is in it genuinely does not fit.
     *
     * The previous version set the height to `auto`, read `scrollHeight`, and wrote that back.
     * For an empty box that returned 120px -- at or past the cap -- so the composer opened
     * 271px tall on a 360x640 phone, the transcript was squeezed to its minimum, and the Send
     * button finished below the bottom of its own dialog. A chat box taller than the
     * conversation in it is wrong before any of that.
     *
     * The fix is to measure against the height the box already has rather than against `auto`:
     * if the content fits in what the stylesheet gives it, the inline height is cleared and
     * CSS decides. Only real overflow grows it, and only up to the cap. The cap matches the
     * `max-height` in the stylesheet, because a textarea that grows past its own `max-height`
     * is clipped rather than scrolled, which loses the last line of what someone typed.
     */
    function autoResize() {
        if (!composer) return;
        if (composer.scrollHeight <= composer.clientHeight) {
            composer.style.height = '';
            return;
        }
        composer.style.height = `${Math.min(composer.scrollHeight, COMPOSER_MAX)}px`;
    }

    /** Rebuilds the opening transcript, so reopening the desk is a fresh conversation. */
    function resetThread() {
        if (!thread) return;
        thread.replaceChildren();
        addMessage('agent', 'Hello. Tell us what happened and we will look into it. '
            + 'Answers go to your email, usually within one business day.');
        addTopicChips();
        setStatus('', '');

        // The first send removes the identity block, because there is nothing left to correct
        // once a reply is on its way. Reopening the desk has to put it back, or the second
        // message in a session has no address to go to.
        let identity = dialog?.querySelector('#helpdesk-identity');
        if (!identity) {
            identity = buildIdentityBlock();
            dialog?.querySelector('.helpdesk-composer')?.before(identity);
        }
        const emailInput = identity.querySelector('#helpdesk-email');
        let email = '';
        try { email = sessionStorage.getItem('rewardZoneEmail') || ''; } catch {
            // Storage unavailable; the visitor types it.
        }
        if (emailInput) emailInput.value = email;

        const subject = dialog.querySelector('#helpdesk-subject');
        if (subject) subject.value = 'Support request';

        if (composer) {
            composer.value = '';
            autoResize();
        }
        updateCount();
    }

    /**
     * The identity block, kept as its own function because `resetThread` has to be able to
     * rebuild the one `send` removed, and two copies of this markup is already one too many.
     */
    function buildIdentityBlock() {
        const block = document.createElement('div');
        block.className = 'helpdesk-identity';
        block.id = 'helpdesk-identity';
        block.innerHTML = `
            <label class="helpdesk-identity-label" for="helpdesk-email">Reply-to email</label>
            <input class="form-input helpdesk-email" type="email" id="helpdesk-email"
                   name="email" maxlength="254" autocomplete="email"
                   placeholder="you@example.com" aria-describedby="helpdesk-email-hint">
            <!-- Deliberately short. This block is a fixed-height flex row, so every word here
                 is a word taken from the transcript on a phone -- the measurement that put the
                 Send button off the bottom of a 360x640 dialog started with a hint three times
                 this length. "Where our answer goes" is the part that matters; the rest is
                 reassurance the reader does not need twice. -->
            <p class="field-hint" id="helpdesk-email-hint">Where our answer goes.</p>
            <input type="hidden" id="helpdesk-subject" name="subject" value="Support request">
        `;
        return block;
    }

    function open() {
        dialog = ensureDialog();
        thread = dialog.querySelector('#helpdesk-thread');
        composer = dialog.querySelector('#helpdesk-message');
        sendButton = dialog.querySelector('#helpdesk-send');
        statusLine = dialog.querySelector('#helpdesk-status');

        // Wired once, on the first open. The dialog element is created lazily and then kept,
        // so re-binding on every open would attach a second `submit` handler each time and
        // every send would go out twice.
        if (!wired) {
            wired = true;
            dialog.querySelector('#helpdesk-form')?.addEventListener('submit', send);
            composer?.addEventListener('input', () => {
                autoResize();
                updateCount();
            });
            dialog.addEventListener('click', (event) => {
                if (event.target === dialog) close();
            });
        }

        // Reuses a signed-in visitor's own address rather than a remembered one, for the same
        // reason the email form does: a stale address in the box means support replies to
        // somebody who is not sitting here.
        let email = '';
        try { email = sessionStorage.getItem('rewardZoneEmail') || ''; } catch {
            // Storage unavailable; the field below falls back to asking for it.
        }
        if (email) {
            const identity = dialog.querySelector('#helpdesk-identity');
            if (identity) identity.textContent = `Replying to ${email}`;
        }

        if (!dialog.open) dialog.showModal();
        resetThread();
        // The composer, not the close button and not the first chip. Someone opening a help desk
        // has a problem in mind, and the fastest route to describing it is typing.
        composer?.focus();
    }

    function close() {
        if (dialog?.open) dialog.close();
    }

    async function send(event) {
        event.preventDefault();
        if (submitting || !composer) return;

        const message = composer.value.trim();
        if (!message) {
            setStatus('Write your message first.', 'error');
            composer.focus();
            return;
        }

        // Where the answer goes. A chat with no address is a chat with no reply, so this is
        // asked for before anything is sent, not discovered from a failure.
        let email = '';
        try { email = sessionStorage.getItem('rewardZoneEmail') || ''; } catch {
            // Storage unavailable.
        }
        const emailInput = dialog.querySelector('#helpdesk-email');
        const address = (emailInput?.value || email).trim();
        if (!address) {
            setStatus('Add an email address so we can reply to you.', 'error');
            emailInput?.focus();
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
            setStatus('That email address does not look right, so nobody would be able to reply.', 'error');
            emailInput?.focus();
            return;
        }

        const name = (dialog.querySelector('#helpdesk-name')?.value || '').trim() || address;
        const subject = dialog.querySelector('#helpdesk-subject')?.value || 'Support request';

        setBusy(true);
        setStatus('Sending...', '');
        addMessage('you', message);
        composer.value = '';
        autoResize();
        updateCount();

        try {
            const response = await fetch('/api/contact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email: address, subject, message })
            });
            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
                // The message stays in the composer. Losing what someone typed because the
                // network blipped is the worst possible moment to clear a textarea.
                composer.value = message;
                autoResize();
                updateCount();
                setStatus(result.error || 'That did not send. Your message is back in the box.', 'error');
                return;
            }

            addMessage('agent', `Sent. We will reply to ${address}, usually within one business day. `
                + 'You can close this and we will find you in your inbox.');
            setStatus('Sent. Check your inbox for the reply.', 'success');
            // The identity line is no longer needed once there is a reply on its way, and
            // leaving an editable address under a finished conversation invites a second,
            // different conversation by accident.
            const identity = dialog.querySelector('#helpdesk-identity');
            if (identity) identity.remove();
        } catch (error) {
            composer.value = message;
            autoResize();
            updateCount();
            setStatus(error.message || 'That did not send. Your message is back in the box.', 'error');
        } finally {
            setBusy(false);
            composer?.focus();
        }
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (!document.querySelector('[data-helpdesk-trigger]')) return;

        for (const trigger of document.querySelectorAll('[data-helpdesk-trigger]')) {
            trigger.addEventListener('click', (event) => {
                event.preventDefault();
                open();
            });
        }

        // Delegated on the document because the dialog is built after this runs, and the chips
        // inside it are created fresh on every open. A listener bound once to a node that is
        // replaced would be attached to a node that no longer exists.
        document.addEventListener('click', (event) => {
            const chip = event.target.closest('.helpdesk-chip');
            if (!chip || !dialog?.contains(chip)) return;
            const topic = TOPICS[Number(chip.dataset.topic)];
            if (!topic || !composer) return;
            // Fills, never sends.
            composer.value = topic.prompt;
            // The subject is what support triages on, so choosing a topic has to carry through
            // to it. Without this every message arrives as "Support request" and the four most
            // common problems become one undifferentiated queue.
            const subject = dialog.querySelector('#helpdesk-subject');
            if (subject) subject.value = topic.subject;
            composer.focus();
            // Put the caret at the end of the prompt, so the next thing typed continues it
            // rather than landing in the middle of the sentence.
            composer.setSelectionRange(topic.prompt.length, topic.prompt.length);
            autoResize();
            updateCount();
        });

        // The close button and the backdrop, delegated on the document so they work no matter
        // when the dialog was built. Escape needs no handler: `showModal()` gives a dialog
        // that behaviour already, and adding a second one races the first.
        document.addEventListener('click', (event) => {
            if (event.target.closest('[data-helpdesk-close]') || event.target === dialog) close();
        });
    });
})();
