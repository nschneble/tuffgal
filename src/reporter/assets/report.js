(function () {
  // Shared writer for the `.story-filter-status` polite live region. Both the
  // filter (debounced) and the bulk-toggle (synchronous) write through this
  // helper so a fresher write always supersedes a pending stale one — the
  // most-recent action wins. `write()` and `writeDebounced()` both implicitly
  // cancel any in-flight debounce before scheduling, so callers cannot
  // accidentally re-introduce the race by forgetting to clear the timer.
  //
  // Contract:
  //   write(msg)             → cancel pending debounce, set textContent now
  //   writeDebounced(msg, ms)→ cancel pending debounce, set textContent after ms
  //
  // Both writers use `textContent` (not `innerHTML`). If the new message
  // equals the current `textContent`, some screen readers will not re-announce
  // — this is a documented platform limitation, not worked around here. A
  // future caller that needs forced re-announcement would add a separate
  // `forceWrite()`; out of scope for this helper.
  //
  // If `.story-filter-status` is missing from the DOM, every method is a
  // silent no-op (matches the prior early-return pattern at each call site).
  function createStatusRegion() {
    var element = document.querySelector('.story-filter-status');
    var timer = null;

    function cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function write(msg) {
      cancel();
      if (!element) return;
      element.textContent = msg;
    }

    function writeDebounced(msg, ms) {
      cancel();
      if (!element) return;
      timer = setTimeout(function () {
        element.textContent = msg;
        timer = null;
      }, ms);
    }

    return {
      write: write,
      writeDebounced: writeDebounced,
    };
  }

  var statusRegion = createStatusRegion();

  // Reveals the matching <div.shot-panel> for the radio the user picks. The
  // radio group already handles keyboard navigation natively (arrow keys move
  // the selection across the visible labels); this script just translates the
  // `change` event into a panel-visibility toggle so we stay framework-free.
  (function () {
    function setupShots(container) {
      var radios = Array.prototype.slice.call(
        container.querySelectorAll('input[type="radio"]'),
      );
      var panels = Array.prototype.slice.call(
        container.parentElement.querySelectorAll('.shot-panel'),
      );

      function activate(name) {
        panels.forEach(function (panel) {
          panel.hidden = panel.getAttribute('data-tab') !== name;
        });
      }

      var defaultTab = container.getAttribute('data-default-tab');
      var initialRadio = radios.find(function (radio) {
        return radio.value === defaultTab && !radio.disabled;
      }) ||
        radios.find(function (radio) {
          return !radio.disabled;
        });
      if (initialRadio) {
        initialRadio.checked = true;
        activate(initialRadio.value);
      }

      radios.forEach(function (radio) {
        radio.addEventListener('change', function () {
          if (radio.disabled) return;
          activate(radio.value);
        });
      });
    }

    document
      .querySelectorAll('.shot-radio')
      .forEach(function (container) {
        setupShots(container);
      });
  })();

  // Status filter for the stories list. Toggles `hidden` on each <li.story>
  // whose `data-status` doesn't match the chosen radio value ("all" disables
  // the filter). Live-region updates are debounced by ~150ms so arrow-key
  // traversal across the radio group doesn't flood the polite region with
  // every intermediate state; the visual hide/show is applied immediately.
  (function () {
    var fieldset = document.querySelector('.story-filter');
    if (!fieldset) return;
    var list = document.querySelector('.stories');
    var empty = document.querySelector('.stories-empty');
    if (!list || !empty) return;

    var stories = Array.prototype.slice.call(list.querySelectorAll('.story'));
    var radios = Array.prototype.slice.call(
      fieldset.querySelectorAll('input[type="radio"]'),
    );
    var total = stories.length;

    // Bulk-toggle buttons re-labelled per active filter so sighted users know
    // the toggle is scoped to the filtered subset (e.g. "Expand all failed
    // screenshots"). This is a synchronous visible-text swap only — no
    // aria-label (would risk WCAG 2.5.3 Label in Name) and no live-region
    // write (the filter announcement already covers the context change, so the
    // statusRegion is intentionally left untouched here).
    var expandButton = document.querySelector('[data-bulk-toggle="expand"]');
    var collapseButton = document.querySelector('[data-bulk-toggle="collapse"]');

    function relabelBulkToggle(name) {
      var scope = name && name !== 'all' ? ' ' + name : '';
      if (expandButton) {
        expandButton.textContent = 'Expand all' + scope + ' screenshots';
      }
      if (collapseButton) {
        collapseButton.textContent = 'Collapse all' + scope + ' screenshots';
      }
    }

    function apply(radio) {
      var value = radio.value;
      var name = radio.getAttribute('data-filter-name') || value;
      relabelBulkToggle(name);
      var visible = 0;
      stories.forEach(function (story) {
        var match =
          value === 'all' || story.getAttribute('data-status') === value;
        story.hidden = !match;
        if (match) visible += 1;
      });
      var hasNone = visible === 0;
      list.hidden = hasNone;
      empty.hidden = !hasNone;

      var message;
      if (value === 'all') {
        message = 'Showing all ' + total + ' stories.';
      } else if (hasNone) {
        message = 'Filter: ' + name + '. No stories match.';
      } else {
        message =
          'Filter: ' + name + '. ' + visible + ' of ' + total + ' stories shown.';
      }

      statusRegion.writeDebounced(message, 150);
    }

    radios.forEach(function (radio) {
      radio.addEventListener('change', function () {
        apply(radio);
      });
    });
  })();

  // Bulk-toggle (expand all / collapse all) for the screenshot <details> panels.
  // Acts on the moment: only visible rows (.story:not([hidden])) are affected,
  // so the filter scope wins. Each <details> retains its own open state per
  // native HTML semantics — newly-revealed stories after a later filter change
  // stay closed by default (their default state). A future maintainer might be
  // tempted to "fix" this by tracking a global expanded mode; don't — the lack
  // of persistence is the agreed accessibility-lead decision (act-on-the-moment).
  //
  // We use `details.open = true/false` rather than `details.click()` so the
  // browser does not dispatch a `toggle` event cascade for every panel.
  //
  // No debounce: bulk-toggle fires once per click (not on every arrow keypress
  // like the filter does), so the live region is not at risk of being flooded.
  // The filter's 150ms debounce exists because radios announce on every arrow
  // move; here a single click → single message is fine.
  //
  // Live-region ordering: bulk-toggle writes synchronously via
  // `statusRegion.write(msg)`, which internally cancels any pending filter
  // debounce set by `writeDebounced`. Result: when a bulk-toggle fires within
  // 150ms of a filter radio change, the most-recent action wins — the screen
  // reader hears only the toggle announcement, not the now-stale filter one.
  // This matches polite-region supersession semantics where unspoken pending
  // updates yield to fresher writes.
  (function () {
    var buttons = Array.prototype.slice.call(
      document.querySelectorAll('[data-bulk-toggle]'),
    );
    if (buttons.length === 0) return;

    function apply(mode) {
      var shouldOpen = mode === 'expand';
      var visibleStories = Array.prototype.slice.call(
        document.querySelectorAll('.story:not([hidden])'),
      );
      visibleStories.forEach(function (story) {
        var panels = Array.prototype.slice.call(
          story.querySelectorAll('details.shots'),
        );
        panels.forEach(function (panel) {
          panel.open = shouldOpen;
        });
      });
      // Announcement count uses visible stories rather than stories-with-details.
      // A visible row with zero details is a no-op for the toggle, but the
      // announcement reads the same to a screen reader either way, and this
      // keeps the logic simple.
      var count = visibleStories.length;
      var verb = shouldOpen ? 'Expanded' : 'Collapsed';
      statusRegion.write(verb + ' screenshots in ' + count + ' stories.');
    }

    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        apply(button.getAttribute('data-bulk-toggle'));
      });
    });
  })();
})();
