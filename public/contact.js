/**
 * Contact support dialog controller.
 *
 * Any link with `data-contact-trigger` opens the contact dialog as a modal.
 * The form posts to /api/contact, which forwards the message to the site owner
 * via the configured email provider.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'rewardZoneContactDraft';
    const contactDialog = typeof document !== 'undefined' ? document.getElementById('contact-dialog') : null;

    function serialize(form) {
        const data = new FormData(form);
        const obj = {};
        for (const [key, value] of data.entries()) {
            obj[key] = value;
        }
        return obj;
    }

    function openDialog() {
        if (!contactDialog) return;
        contactDialog.showModal();
        const nameInput = contactDialog.querySelector('#contact-name');
        const subjectInput = contactDialog.querySelector('#contact-subject');
        if (nameInput && !nameInput.value) {
            const draft = readDraft();
            if (draft.name) nameInput.value = draft.name;
            if (draft.subject && subjectInput) subjectInput.value = draft.subject;
            const firstField = nameInput || subjectInput;
            if (firstField) firstField.focus();
        }
        contactDialog.querySelector('#contact-message')?.focus();
    }

    function closeDialog() {
        if (!contactDialog) return;
        contactDialog.close();
    }

    function readDraft() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            // Storage disabled or corrupt: a blank form is a tolerable fallback.
            return {};
        }
    }

    function saveDraft(form) {
        try {
            const data = serialize(form);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch {
            // Storage full or unavailable: the in-memory form still submits.
        }
    }

    function clearDraft() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            // Storage unavailable.
        }
    }

    function autoResize(textarea) {
        if (textarea && textarea.scrollHeight) {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 320) + 'px';
        }
    }

    async function submitForm(event) {
        event.preventDefault();
        const form = event.target;
        const submit = form.querySelector('#contact-submit');
        const messageBox = form.querySelector('#contact-form-message');

        if (!submit || !messageBox) return;

        const data = serialize(form);

        // Every required field, checked here.
        //
        // The server requires all four and this used to check three. A form with an empty
        // Subject passed the client, was posted, and came back 400 "Missing required field:
        // subject" -- which reads as the site being broken rather than as a field the visitor
        // had left blank. `novalidate` on the form is why the browser's own required-field
        // messages are not doing this job.
        const missing = ['name', 'email', 'subject', 'message']
            .filter((field) => !String(data[field] || '').trim());
        if (missing.length > 0) {
            showError(messageBox, missing.length === 1
                ? 'Fill in every field before sending.'
                : 'Fill in every field before sending. The empty ones are marked.');
            markInvalid(form, missing);
            form.querySelector(`[name="${missing[0]}"]`)?.focus();
            return;
        }
        clearInvalid(form);

        // An address that cannot receive a reply is a message nobody can answer, and the
        // browser's own email validation is off because the form is `novalidate`.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(data.email).trim())) {
            showError(messageBox, 'That email address does not look right, so nobody would be able to reply.');
            markInvalid(form, ['email']);
            form.querySelector('#contact-email')?.focus();
            return;
        }

        submit.disabled = true;
        submit.textContent = 'Sending...';
        messageBox.textContent = '';
        messageBox.className = 'form-message';
        setCharacterCount(form, 0);

        try {
            const response = await fetch('/api/contact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            const result = await response.json().catch(() => ({}));

            if (response.ok) {
                messageBox.textContent = 'Your message has been sent. We typically respond within one business day.';
                messageBox.className = 'form-message success';
                form.reset();
                clearDraft();
                clearInvalid(form);
                // Long enough to read. The dialog closing on them is how a sent message
                // becomes a message they are not sure went anywhere.
                setTimeout(closeDialog, 4000);
            } else {
                markInvalid(form, result.missing || []);
                showError(messageBox, result.error || 'Failed to send message.');
            }
        } catch (error) {
            showError(messageBox, error.message || 'Something went wrong. Please try again.');
        } finally {
            submit.disabled = false;
            submit.textContent = 'Send message';
        }
    }

    function showError(messageBox, text) {
        messageBox.textContent = text;
        messageBox.className = 'form-message error';
    }

    /**
     * Marks fields the server named as missing, and clears the marks on the others.
     *
     * Driven by the server's answer rather than the local check, because the local check is
     * only a faster path to the same conclusion and the server is the authority: it is what
     * rejected the submission.
     */
    function markInvalid(form, fields) {
        const set = new Set(fields || []);
        form.querySelectorAll('[name]').forEach((field) => {
            const invalid = set.has(field.name);
            field.classList.toggle('is-invalid', invalid);
            field.setAttribute('aria-invalid', invalid ? 'true' : 'false');
        });
    }

    function clearInvalid(form) {
        markInvalid(form, []);
    }

    /**
     * The "n of 2000" counter under the message box.
     *
     * `maxlength` stops a long message silently at the limit; the counter is what tells the
     * writer the limit exists and how close they are to it, which is the difference between
     * a character budget and a surprise.
     */
    function setCharacterCount(form, remaining) {
        const counter = form.querySelector('#contact-count');
        const message = form.querySelector('#contact-message');
        if (!counter || !message) return;
        const limit = Number(message.getAttribute('maxlength')) || 0;
        if (limit === 0) return;
        const used = limit - remaining;
        counter.textContent = remaining <= 0 ? 'Message is full' : `${remaining} characters left`;
        counter.classList.toggle('is-warning', remaining > 0 && remaining <= 200);
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (!contactDialog) return;

        const form = contactDialog.querySelector('#contact-form');

        // Close buttons
        contactDialog.querySelector('[data-close="contact-dialog"]')?.addEventListener('click', closeDialog);
        contactDialog.addEventListener('click', (event) => {
            if (event.target === contactDialog) closeDialog();
        });

        // Form submission
        form?.addEventListener('submit', submitForm);

        // Draft saving
        if (form) {
            form.addEventListener('input', () => saveDraft(form));
            // A field the visitor has just corrected should stop being marked wrong. Left
            // alone, a red border sits under a value that is now fine, and the only way to
            // clear it is to submit.
            form.querySelectorAll('.is-invalid').forEach((field) => {
                field.addEventListener('input', () => {
                    field.classList.remove('is-invalid');
                    field.setAttribute('aria-invalid', 'false');
                });
            });
        }

        // Textarea auto-resize and the remaining-character count
        const textarea = contactDialog.querySelector('#contact-message');
        if (textarea) {
            const update = () => {
                autoResize(textarea);
                setCharacterCount(contactDialog.querySelector('#contact-form'), textarea.maxLength - textarea.value.length);
            };
            textarea.addEventListener('input', update);
            update();
        }

        // Open from any trigger link
            document.querySelectorAll('[data-contact-trigger]').forEach((link) => {
            link.addEventListener('click', (event) => {
                event.preventDefault();
                // The signed-in address, if there is a session. Read from the key `app.js`
                // writes at sign-in rather than a remembered one: a previous visit's address
                // would pre-fill the form for a visitor who has since signed in as somebody
                // else, and support would reply to the wrong person.
                let email = '';
                try { email = sessionStorage.getItem('rewardZoneEmail') || ''; } catch {
                    // Storage unavailable; the field stays blank and the visitor types it.
                }
                const emailInput = contactDialog.querySelector('#contact-email');
                if (emailInput) emailInput.value = email;
                openDialog();
            });
        });
    });
})();
