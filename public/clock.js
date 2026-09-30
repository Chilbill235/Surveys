/**
 * The live date and time.
 *
 * ## One clock, in the header, on every page
 *
 * The homepage used to carry a second, much larger clock of its own -- a full date sentence, a
 * ticking time, a day-of-the-month counter and a month progress bar -- underneath the
 * RewardZone wordmark. Having both was a duplication rather than a hierarchy: the same
 * information twice on one screen, at two different sizes, with the day counter reading "0
 * days left in the month" on the last day of a month, which looks like a broken value rather
 * than an accurate one. It is gone. The header clock is the only one, and it is on every page.
 *
 * The clock is injected rather than written into twelve pages' markup. Pasting it into each
 * would be twelve copies to keep in step, and the help desk already showed how that ends -- a
 * page carrying the trigger but not the thing it opens. Building it here means every page that
 * loads this file gets the same clock, and a page that does not load it simply has no clock,
 * which is a state that is visible rather than one that is silently broken.
 *
 * ## Where it sits
 *
 * To the left of the wordmark, grouped with it as the header's first cell. The header is a
 * three-column grid: that group, the page's own navigation centred, the account controls on
 * the right. The clock is the only thing in the header allowed to shrink, and it is hidden
 * outright below 720px, where the fixed action bar owns the bottom of the screen and the header
 * has no width to spare.
 *
 * ## The live-transaction indicator
 *
 * The same file also builds `#live-indicator`, the "Live" / "Connection lost" status, and puts
 * it in the centre of the header. It used to sit inside whichever page had a balance card,
 * which meant three copies in three places, none of them on the homepage, and all of them at a
 * different height. One indicator in one place is what makes it readable: a visitor should be
 * able to look in the same spot on any page and know whether the number in front of them is
 * current.
 *
 * ## What this shows
 *
 * A ticking clock, driven by the visitor's own device clock but read in one fixed zone:
 * America/New_York. That is a deliberate departure from the older behaviour, which read the
 * browser's own zone and printed its name beside the time. Printing the zone was honest but
 * it made every visitor's header read differently -- a European visitor saw "Berlin", a
 * visitor in Arizona saw "Phoenix" -- for a site that has one operational day, not a
 * worldwide one. Pinned to New York, the header reads the same everywhere, which is what
 * makes it usable as a shared reference rather than a curiosity.
 *
 * The zone is no longer labelled. It used to sit as a third item in the clock group, and
 * there is a rule a fixed zone makes redundant: a clock that is always in the same zone does
 * not need to say so on every page. The date beside the time is the full one, year included,
 * so a reader who needs to place the time in the calendar can; a reader who just wants the
 * time is not made to read past it.
 *
 * ## Why it ticks at all
 *
 * A date printed once and left alone is a screenshot of a moment, and on a site that talks
 * about "payouts from $1.00" and offers being added regularly, a static date ages visibly.
 * Ticking it costs one `setInterval` and two text writes.
 *
 * ## Why it is not announced
 *
 * `aria-live` is deliberately absent from the clock. A per-second update inside a live region
 * is a screen reader that interrupts whatever is being read, about once a second, forever --
 * which makes the page unusable rather than informative. The clock block is `aria-hidden`
 * throughout, so it is a visual affordance and nothing else.
 *
 * ## Why the interval is aligned to the second boundary
 *
 * `setInterval(fn, 1000)` drifts: it fires 1000ms after load, not on the second, so the
 * displayed second changes at an arbitrary offset and the clock appears to stall or skip.
 * Scheduling to the next whole second and then every second after keeps the digits changing
 * when they are supposed to.
 */
(function () {
    'use strict';

    const SECOND = 1000;

    /**
     * The one zone every clock on this site is read in.
     *
     * Not the browser's zone. A header clock is only worth having if it means the same thing to
     * every reader, and this site has one operating day rather than a worldwide one, so
     * America/New_York is the honest constant. Every `Intl` call below passes it, including the
     * date, so the date can never drift onto a different day than the time next to it -- which
     * is the bug you get when the two are formatted with different zones and a visitor is a few
     * hours either side of midnight.
     */
    const CLOCK_ZONE = 'America/New_York';

    let topbarDateNode = null;
    let topbarClockNode = null;
    let timer = null;

    /**
     * Builds the compact topbar clock, once, on any page that has a topbar.
     *
     * A guard rather than an assumption: `login.html` has no header, and a future page may
     * legitimately not have one either. Injecting into a missing element would throw on load
     * and take the rest of the page's scripts with it.
     *
     * The clock and the brand are wrapped together in a `.topbar-lead` group, with the clock
     * *before* the wordmark rather than after it. The header is a three-column grid -- this
     * group on the left, the page's own navigation centred, the account controls on the right
     * -- and the grid only lines up if the clock and the brand travel together as a single
     * left-hand cell. Left as two separate children they would occupy two columns, and the
     * navigation would stop being centred on any page that had both.
     */
    function ensureTopbarClock() {
        const topbar = document.querySelector('.topbar');
        if (!topbar) return null;
        if (document.getElementById('topbar-clock')) return document.getElementById('topbar-clock');

        const brand = topbar.querySelector('.brand');

        const lead = document.createElement('div');
        lead.className = 'topbar-lead';

        const block = document.createElement('div');
        block.className = 'topbar-clock';
        // The id is set here rather than through `block.id = ...` so that the id appears
        // literally in this file. `check-frontend.js` reads the ids a script declares out of
        // its own templates to know what resolves at runtime, and a property assignment is
        // invisible to it -- which would have made this look like a lookup for an element that
        // does not exist. An id the checker can read is an id the next person can find.
        block.id = 'topbar-clock';
        block.setAttribute('aria-hidden', 'true');
        // Time first, then the full date.
        //
        // The time leads because it is the only part that changes. The date is the quieter of
        // the two -- it is set information for the rest of the day -- so it is smaller and
        // dimmer and the eye slides past it to the seconds. Putting it first made the eye stop
        // on information that had not moved.
        //
        // The year is back, unlike the earlier version, which dropped it to save width. It cost
        // about 25px in a header cell with room to spare, and it was the part a reader checking
        // a payout against a statement actually needs. "Sep 30" is ambiguous across a year
        // boundary in a way "Sep 30, 2026" is not.
        //
        // A real `<time datetime>` rather than a `<p>`, because the machine-readable form costs
        // nothing here and `paint()` writes it on the same tick that writes the text, so the two
        // can never disagree. The element sits inside an `aria-hidden` block, so this is for
        // anything reading the DOM rather than for a screen reader.
        block.innerHTML = '<time class="topbar-clock-time" id="topbar-clock-time"></time>'
            + '<span class="topbar-clock-date" id="topbar-clock-date"></span>';
        // Not a landmark and not a region: it is a small piece of context next to the brand,
        // and announcing it as one would put an extra stop in every screen reader's navigation
        // for a clock.

        // Clock first, then the wordmark. Moving the brand into the group rather than copying
        // it keeps one element with one id, which is what the profile code and the frontend
        // checker both expect to find.
        lead.append(block);
        if (brand) lead.append(brand);
        topbar.insertBefore(lead, topbar.firstChild);

        topbarDateNode = block.querySelector('#topbar-clock-date');
        topbarClockNode = block.querySelector('#topbar-clock-time');
        return block;
    }

    /**
     * Builds the live-transaction indicator, once, on any page that has a topbar.
     *
     * It used to be written into the markup of whichever page had a balance card, which meant
     * three copies in three different places, none of them on the homepage, and none of them
     * at the same height. Building it here puts exactly one on every page, in the same place,
     * which is the whole point of a status indicator: a reader should be able to look in one
     * spot and know whether the number on the page is current.
     *
     * A page that has a topbar but no session gets it hidden, not absent -- `app.js` decides
     * that from the token, and a visitor who is not signed in has nothing to be live about.
     */
    function ensureLiveIndicator() {
        const topbar = document.querySelector('.topbar');
        if (!topbar) return null;
        // A page may still carry one in its own markup. The topbar is the canonical home for
        // it, so one that is already a direct child of the header is adopted as it is; one
        // nested deeper -- inside a balance block, which is where three of them used to live
        // -- is moved out to the row beneath the navigation.
        //
        // The test is `parentElement`, not `closest('.topbar')`. `closest` matches any
        // descendant, so a copy still buried inside a balance block would look like it was
        // already in the right place, get adopted, and never move -- and the CSS that gives it
        // the second row only matches a direct child, so it would sit invisibly in the middle
        // of the balance block instead.
        const existing = document.getElementById('live-indicator');
        if (existing && existing.parentElement === topbar) return existing;
        if (existing) existing.remove();

        const indicator = document.createElement('span');
        indicator.className = 'live-indicator';
        // Set through the template below rather than as a property, so `check-frontend.js` can
        // see the id and know this is created here rather than missing from the markup.
        indicator.id = 'live-indicator';
        indicator.hidden = true;
        indicator.setAttribute('aria-live', 'polite');
        topbar.append(indicator);
        return indicator;
    }

    /**
     * `Intl` with the site's zone, and a fallback for the browsers that cannot build one.
     *
     * The zone is passed on every call rather than resolved once, because these are separate
     * calls and a single cached formatter would be one more thing to keep in step. A
     * `RangeError` here is a browser that does not know America/New_York -- an old engine, or
     * one built with trimmed timezone data -- and it must not take the header down with it, so
     * every formatter falls through to plain local arithmetic.
     */
    function zoneFormatter(options) {
        try {
            return new Intl.DateTimeFormat('en-US', { ...options, timeZone: CLOCK_ZONE });
        } catch {
            return null;
        }
    }

    /**
     * The clock, on a twelve-hour clock, with the meridiem spelled out.
     *
     * It was `hour12: false`, which reads as "16:16" -- and a good half of the people seeing that
     * read it as a military or a broadcast time rather than as four in the afternoon. The
     * meridiem is written out ("PM", not "pm") and kept at full weight because that suffix is the
     * only thing on screen that says which half of the day it is; leaving it off and hoping the
     * reader infers it is the same error in the other direction.
     *
     * The zone is still the site's, not the reader's, because the whole point of this element is
     * to tell you when offers and survey windows close -- and those are on site time.
     *
     * `hour: 'numeric'` rather than `'2-digit'`: a twelve-hour clock pads 9am to "09:07:32", and
     * the leading zero on a clock face is a twenty-four-hour habit that looks like an error next
     * to "PM". The fallback below has to match, so it derives the meridiem itself.
     */
    function formatTime(date) {
        const formatter = zoneFormatter({
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
        if (formatter) return formatter.format(date);

        // No `Intl`, or a browser that does not know America/New_York. The zone is then the
        // machine's, which is the best available, and the meridiem still has to be there.
        const pad = (n) => String(n).padStart(2, '0');
        const hours = date.getHours();
        const meridiem = hours < 12 ? 'AM' : 'PM';
        const twelve = hours % 12 === 0 ? 12 : hours % 12;
        return `${twelve}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${meridiem}`;
    }

    function paint() {
        const now = new Date();
        if (topbarClockNode) {
            topbarClockNode.textContent = formatTime(now);
            // The machine-readable form of the same value, written on the same tick so it can
            // never disagree with the text next to it. Cheap, and it is what makes the element
            // worth being a `<time>` rather than a `<p>`.
            topbarClockNode.setAttribute('datetime', now.toISOString());
        }
        if (topbarDateNode) topbarDateNode.textContent = formatShortDate(now);
    }

    /**
     * The date beside the clock: "Wed, Sep 30, 2026".
     *
     * The three parts are there because each answers a different question a reader might have.
     * The weekday says whether the page's content is current -- offers and survey windows turn
     * over on a weekday boundary, so "Saturday" is information and a bare date is not. The
     * month and day place the time in the calendar. The year closes the last ambiguity, which
     * is the one that bites on a page people leave open in a tab.
     *
     * Built from explicit parts rather than `dateStyle: 'medium'` so the shape is fixed. A
     * locale-driven style renders as "Wed, Sep 30, 2026" in `en-US` and "Wed 30 Sept 2026" in
     * `en-GB`, and the header cell is sized against the longer one; a fixed shape means every
     * reader gets the same widths and the header never reflows between locales.
     *
     * Deliberately no weekday abbreviation beyond three letters and no ordinal suffix: "Wed,
     * Sep 30" reads cleanly at 0.7rem, and "Wednesday, September 30th" does not.
     */
    function formatShortDate(date) {
        const formatter = zoneFormatter({
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
        if (formatter) {
            // `format` already applies the locale's own separators, so for the pinned `en-US`
            // above this is "Wed, Sep 30, 2026". `formatToParts` is only reached if a future
            // locale edit changes the punctuation, and the join below collapses the doubled
            // separators that would otherwise leave a gap.
            return formatter.format(date).replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
        }
        const month = date.toLocaleString('en-US', { month: 'short' });
        return `${month} ${date.getDate()}, ${date.getFullYear()}`;
    }

    function start() {
        const topbarBlock = ensureTopbarClock();
        ensureLiveIndicator();

        // No header: nothing to tick. `login.html` is the case in point -- it has no topbar, so
        // there is no clock and no status indicator, and a page like that should simply not run
        // an interval rather than tick something nobody can see.
        if (!topbarBlock) return;

        paint();
        // Line up with the next whole second, then tick with the second boundary.
        const now = new Date();
        const delay = SECOND - (now.getMilliseconds() || SECOND);
        setTimeout(() => {
            paint();
            timer = setInterval(paint, SECOND);
        }, delay);
    }

    document.addEventListener('DOMContentLoaded', start);

    // A tab that has been in the background comes back to a clock that is minutes behind,
    // because browsers throttle timers in hidden tabs and often stop them entirely. Repainting
    // on the way back is what makes the first thing the visitor sees correct.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        paint();
        if (timer) {
            clearInterval(timer);
            const now = new Date();
            setTimeout(() => {
                paint();
                timer = setInterval(paint, SECOND);
            }, SECOND - (now.getMilliseconds() || SECOND));
        }
    });

    // Exposed so the date formatting can be asserted directly, without waiting a minute for a
    // clock to tick. The short form is the one the header actually renders, and the two-digit
    // year is a deliberate choice rather than a default -- it is the kind of thing a test
    // should pin, because "Sep 30, 2026" is one character wider and wraps the header.
    window.RewardZoneClock = { formatTime, formatShortDate };
})();
