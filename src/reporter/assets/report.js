// This file is browser-side and runs outside the `node:test` boundary (the
// project has no DOM harness), so its behavior is covered by manual/visual
// verification rather than unit tests.
(function () {
  // Writer factory for a polite live region, bound to the element matched by
  // `selector`. Two instances exist: one for the filter status line and one for
  // the (sr-only) bulk-toggle status. They are kept separate so toggling
  // screenshots never overwrites the visible filter status; each region is
  // written by a single user action, so they cannot race each other.
  //
  // Within one region, `write()` and `writeDebounced()` both implicitly cancel
  // any in-flight debounce before scheduling, so a fresher write supersedes a
  // pending stale one for that region.
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
  // If `selector` matches nothing, every method is a silent no-op (matches the
  // prior early-return pattern at each call site).
  function createStatusRegion(selector) {
    var element = document.querySelector(selector);
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

  var statusRegion = createStatusRegion('.story-filter-status');
  var bulkRegion = createStatusRegion('.bulk-toggle-status');

  // The visible label word for a filter button, used to echo the active filter
  // in the bulk-toggle announcement (e.g. "Expanded passed in 3 stories"). The
  // button's `data-filter` carries the matcher TOKEN ("pass"); the visible
  // `.indicator` span carries the human LABEL ("passed"). The "all" total maps to
  // "all" regardless of its visible "stories" label. A missing button → "all".
  function filterLabel(button) {
    if (!button) return 'all';
    if (button.getAttribute('data-filter') === 'all') return 'all';
    var indicator = button.querySelector('.indicator');
    return indicator
      ? indicator.textContent.trim()
      : button.getAttribute('data-filter');
  }

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
      var initialRadio =
        radios.find(function (radio) {
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

    document.querySelectorAll('.shot-radio').forEach(function (container) {
      setupShots(container);
    });
  })();

  // Interactive screenshot viewer (rendered when the report is built with
  // interactiveMode). Each action shows ONE shared <img>. A native radio group
  // is the committed-state source of truth — keyboard, touch, and AT operate it
  // exactly like the radio-tab viewer. On top of that, the mouse gesture is a
  // STATELESS visual preview layered on the same <img>:
  //   hover  (mouseenter/mousemove) → baseline src
  //   press  (mousedown)            → diff src (no-op when there is no diff)
  //   release/leave (mouseup/mouseleave) → revert to the checked radio's variant
  // The preview ONLY rewrites img.src. It never changes the checked radio, the
  // img alt, any ARIA attribute, or any live region — so hovering announces
  // nothing by construction. The mouse listeners live on the .shot-stage wrapper
  // rather than the <img>, keeping the image itself handler-free and
  // non-focusable. Non-interactive reports have no .shot-interactive nodes, so
  // this block is a no-op there (and setupShots is a no-op on interactive ones).
  (function () {
    var VARIANT_LABELS = {
      baseline: 'Baseline',
      actual: 'Actual',
      diff: 'Diff',
    };

    function setupInteractiveShots(fieldset) {
      var root = fieldset.parentElement;
      if (!root) return;
      var stage = root.querySelector('.shot-stage');
      var image = root.querySelector('.shot-image');
      if (!stage || !image) return;
      var captionVariant = fieldset.querySelector('.shot-caption-variant');
      var radios = Array.prototype.slice.call(
        fieldset.querySelectorAll('input[type="radio"]'),
      );

      // Map each AVAILABLE variant to its src, read off the shared <img>'s
      // data-src-* attributes. Absent variants (e.g. diff on a clean pass) have
      // no attribute, so they never enter the map and every lookup is a no-op.
      var sources = {};
      ['baseline', 'actual', 'diff'].forEach(function (variant) {
        var src = image.getAttribute('data-src-' + variant);
        if (src !== null) sources[variant] = src;
      });

      // `committed` mirrors the checked radio — the ONLY state the keyboard /
      // touch / AT path mutates. Mouse preview reverts here on release/leave.
      var committed = null;
      var pressed = false;

      function commit(variant) {
        if (!(variant in sources)) return;
        committed = variant;
        image.src = sources[variant];
        if (captionVariant) {
          captionVariant.textContent = VARIANT_LABELS[variant] || variant;
        }
      }

      // Show a variant WITHOUT committing (mouse preview). No-op when the variant
      // has no src, so press-with-no-diff leaves the displayed image untouched.
      function preview(variant) {
        if (!(variant in sources)) return;
        image.src = sources[variant];
      }

      function revert() {
        if (committed && committed in sources) {
          image.src = sources[committed];
        }
      }

      var initial =
        radios.find(function (radio) {
          return radio.checked;
        }) || radios[0];
      if (initial) commit(initial.value);

      radios.forEach(function (radio) {
        radio.addEventListener('change', function () {
          commit(radio.value);
        });
      });

      function hoverPreview() {
        // While not pressed, hovering previews the baseline for an in-place
        // compare. The pressed guard keeps a held mousedown pinned to diff even
        // as the pointer moves across the image.
        if (!pressed) preview('baseline');
      }

      stage.addEventListener('mouseenter', hoverPreview);
      stage.addEventListener('mousemove', hoverPreview);
      stage.addEventListener('mousedown', function () {
        pressed = true;
        preview('diff');
      });
      stage.addEventListener('mouseup', function () {
        pressed = false;
        revert();
      });
      stage.addEventListener('mouseleave', function () {
        pressed = false;
        revert();
      });
    }

    document
      .querySelectorAll('.shot-interactive')
      .forEach(function (fieldset) {
        setupInteractiveShots(fieldset);
      });
  })();

  // Status filter for the stories list. Each status total in the summary row is
  // a native <button aria-pressed> single-select filter; clicking one toggles
  // `hidden` on every <li.story> whose `data-status` doesn't match its
  // `data-filter` token ("all" clears the filter). Exactly one button is pressed
  // at all times (default: the "all/stories" button). Re-clicking the active
  // non-"all" filter reverts to "all". Live-region updates are debounced by
  // ~150ms; the visual hide/show is applied immediately.
  (function () {
    var filterButtons = Array.prototype.slice.call(
      document.querySelectorAll('.summary-filter'),
    );
    if (filterButtons.length === 0) return;
    var list = document.querySelector('.stories');
    var empty = document.querySelector('.stories-empty');
    if (!list || !empty) return;

    var stories = Array.prototype.slice.call(list.querySelectorAll('.story'));
    var total = stories.length;
    var allButton =
      filterButtons.find(function (button) {
        return button.getAttribute('data-filter') === 'all';
      }) || filterButtons[0];

    // Cached for the zero-match disable + focus-rescue logic in apply(). The
    // scope word is now static markup ("screenshots" visible, " all screenshots"
    // sr-only), so the buttons are never relabelled per filter — the filter's own
    // live-region announcement already covers the context change.
    var expandButton = document.querySelector('[data-bulk-toggle="expand"]');
    var collapseButton = document.querySelector(
      '[data-bulk-toggle="collapse"]',
    );

    // Maintain the single-pressed invariant: exactly one filter button carries
    // aria-pressed="true".
    function setPressed(active) {
      filterButtons.forEach(function (button) {
        button.setAttribute(
          'aria-pressed',
          button === active ? 'true' : 'false',
        );
      });
    }

    function show(el) {
      el.hidden = false;
    }

    // True when `container` holds at least one `.action` that is not hidden.
    // Drives whether a breakpoint group / actions list earns its place under an
    // active filter.
    function hasVisibleAction(container) {
      return Array.prototype.some.call(
        container.querySelectorAll('.action'),
        function (action) {
          return !action.hidden;
        },
      );
    }

    // Apply the active filter top-down: story → breakpoint group → action. A
    // non-"all" filter does more than hide whole stories — inside a matching
    // story it also prunes the actions (and the now-empty breakpoint groups /
    // actions lists) that don't match, so e.g. the "changed" view shows ONLY the
    // changed rows of a changed story, never the pass rows that happen to share
    // it. Expand-all then opens only those surviving rows.
    function applyToStory(story, value) {
      var actions = Array.prototype.slice.call(
        story.querySelectorAll('.action'),
      );
      var groups = Array.prototype.slice.call(
        story.querySelectorAll('.breakpoint-group'),
      );
      var lists = Array.prototype.slice.call(
        story.querySelectorAll('ol.actions'),
      );

      // Story visibility keeps the worst-wins rollup semantics: a story shows
      // only when its own status matches (or the filter is "all").
      var storyMatches =
        value === 'all' || story.getAttribute('data-status') === value;
      if (!storyMatches) {
        story.hidden = true;
        // Clear inner pruning so switching back to a matching filter — or to
        // "all" — starts from a clean slate rather than inheriting stale hides.
        actions.forEach(show);
        groups.forEach(show);
        lists.forEach(show);
        return false;
      }

      if (value === 'all') {
        story.hidden = false;
        actions.forEach(show);
        groups.forEach(show);
        lists.forEach(show);
        return true;
      }

      // Matching story under a specific filter: compare each action's
      // data-status against the button's data-filter TOKEN ("pass"), not its
      // visible label ("passed"), so the "passed" filter matches the `pass`
      // actions instead of silently emptying every story.
      actions.forEach(function (action) {
        action.hidden = action.getAttribute('data-status') !== value;
      });
      groups.forEach(function (group) {
        group.hidden = !hasVisibleAction(group);
      });
      lists.forEach(function (listEl) {
        listEl.hidden = !hasVisibleAction(listEl);
      });

      // A worst-wins rollup guarantees at least one matching action, but guard
      // the invariant: a story that pruned to nothing is hidden and uncounted
      // so the "N of M" announcement stays truthful.
      var storyVisible = actions.some(function (action) {
        return !action.hidden;
      });
      story.hidden = !storyVisible;
      return storyVisible;
    }

    function apply(value, button, trigger) {
      var visible = 0;
      stories.forEach(function (story) {
        if (applyToStory(story, value)) visible += 1;
      });
      var hasNone = visible === 0;
      list.hidden = hasNone;
      empty.hidden = !hasNone;

      // Disable-while-focused guard: when a zero-match filter is about to
      // disable a bulk-toggle button that currently holds focus, move focus to
      // the triggering filter control FIRST, so focus is never stranded on a
      // disabled (unfocusable) button.
      if (
        hasNone &&
        trigger &&
        (document.activeElement === expandButton ||
          document.activeElement === collapseButton)
      ) {
        trigger.focus();
      }
      // Disable both bulk-toggle buttons when the active filter matches zero
      // stories — there is nothing to expand/collapse. Runs on EVERY apply()
      // call (including "all"), so selecting a matching filter re-enables them.
      if (expandButton) expandButton.disabled = hasNone;
      if (collapseButton) collapseButton.disabled = hasNone;

      var message =
        value === 'all'
          ? 'Showing all ' + total + ' stories'
          : 'Showing ' + visible + ' of ' + total + ' stories';

      statusRegion.writeDebounced(message, 150);

      // Post-apply focus-loss guard: if filtering left focus on nothing, the
      // body, or inside a now-[hidden] subtree, return it to the control that
      // triggered this apply so keyboard users keep their place.
      var active = document.activeElement;
      if (
        trigger &&
        (!active ||
          active === document.body ||
          (active.closest && active.closest('[hidden]')))
      ) {
        trigger.focus();
      }
    }

    filterButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        var token = button.getAttribute('data-filter');
        var isActive = button.getAttribute('aria-pressed') === 'true';
        // Re-clicking the active, non-"all" filter reverts to "all". Focus stays
        // on the clicked button — it is in the summary row and never hidden by
        // its own action.
        if (isActive && token !== 'all') {
          setPressed(allButton);
          apply('all', allButton, button);
          return;
        }
        // Re-clicking the already-active "all" button is a no-op.
        if (isActive) return;
        setPressed(button);
        apply(token, button, button);
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
  // Toggle announcements go to their own `.bulk-toggle-status` region via
  // `bulkRegion.write(msg)`, NOT the filter's `.story-filter-status`. Toggling
  // screenshots is orthogonal to the filter, so it leaves the visible filter
  // status line untouched. The two regions never write on the same action, so
  // there is no cross-region race to arbitrate.
  (function () {
    var buttons = Array.prototype.slice.call(
      document.querySelectorAll('[data-bulk-toggle]'),
    );
    if (buttons.length === 0) return;

    function apply(mode) {
      var shouldOpen = mode === 'expand';
      // Collapse-all focus rescue: if focus sits inside a disclosure that is
      // about to collapse, move it to that disclosure's <summary> first — the
      // summary stays visible after collapse, so focus is never dropped into a
      // hidden subtree. Expand-all reveals content, so it needs no rescue.
      if (!shouldOpen) {
        var active = document.activeElement;
        var openDetails =
          active &&
          active.closest &&
          active.closest('details.shots[open]');
        if (openDetails) {
          var summary = openDetails.querySelector('summary');
          if (summary) summary.focus();
        }
      }
      var visibleStories = Array.prototype.slice.call(
        document.querySelectorAll('.story:not([hidden])'),
      );
      visibleStories.forEach(function (story) {
        // Only the rows surviving the active filter — `.action:not([hidden])` —
        // get toggled, so "Expand all" under e.g. the changed filter opens just
        // the changed screenshots, not the pass rows sharing the same story.
        var panels = Array.prototype.slice.call(
          story.querySelectorAll('.action:not([hidden]) details.shots'),
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
      // Echo the active filter scope so the announcement matches the
      // filter-aware button label (e.g. "Expanded passed in 3 stories"). Read
      // the pressed filter button at click time via the shared filterLabel
      // helper. No pressed button falls back to "all".
      var pressed = document.querySelector('.summary-filter[aria-pressed="true"]');
      var name = filterLabel(pressed);
      bulkRegion.write(verb + ' ' + name + ' in ' + count + ' stories');
    }

    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        apply(button.getAttribute('data-bulk-toggle'));
      });
    });
  })();

  // Scroll a user-opened screenshot disclosure to the top of the viewport so the
  // tall screenshot below the summary row is immediately visible. Fires ONLY on a
  // user single-open:
  //   - The bulk-toggle sets `details.open` directly, which fires `toggle` but NO
  //     `click`, so a summary `click` listener never catches a bulk op (no
  //     scroll-thrash to the last-opened panel).
  //   - Native <summary> activation by mouse, Enter, or Space all dispatch one
  //     `click`, so a single listener covers every input mode.
  //   - The open-state flip is the click's DEFAULT action, run AFTER this handler,
  //     so `details.open` here is the PRE-toggle state. `if (open) return` means
  //     this click is closing the panel: never scroll on close.
  //   - Deferred to rAF so it runs after the flip + content layout. scrollIntoView
  //     does not move focus, so focus stays on the <summary>, which sits flush at
  //     the viewport top with its focus indicator visible.
  (function () {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    document.addEventListener('click', function (event) {
      var target = event.target;
      var summary = target && target.closest ? target.closest('summary') : null;
      if (!summary) return;
      var details = summary.parentElement;
      if (!details || !details.matches('details.shots')) return;
      // Pre-toggle state: open === "this click will close it" → do not scroll.
      if (details.open) return;
      requestAnimationFrame(function () {
        details.scrollIntoView({
          behavior: reduce.matches ? 'instant' : 'smooth',
          block: 'start',
          inline: 'nearest',
        });
      });
    });
  })();
})();
