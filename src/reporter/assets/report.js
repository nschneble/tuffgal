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
      function reset() {
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
      }
      reset();

      radios.forEach(function (radio) {
        radio.addEventListener('change', function () {
          if (radio.disabled) return;
          activate(radio.value);
        });
      });

      // Selection lives in the DOM, so a collapse only HIDES it — a prior
      // Baseline/Diff pick would otherwise still be checked on the next expand.
      // Reset on COLLAPSE, not expand: the `toggle` event fires AFTER the state
      // change, so resetting on open flashes a visible baseline→actual jump.
      // Resetting on close does the swap while the panel is hidden, so the next
      // expand is already on the default. <details> fires `toggle` on user clicks
      // AND the bulk-toggle's programmatic `open` change, so this covers
      // Collapse-all too. First-ever open is covered by the initial reset() above.
      var details = container.closest && container.closest('details.shots');
      if (details) {
        details.addEventListener('toggle', function () {
          if (!details.open) reset();
        });
      }
    }

    document.querySelectorAll('.shot-radio').forEach(function (container) {
      setupShots(container);
    });
  })();

  // Interactive screenshot viewer (rendered when the report is built with
  // interactiveMode). Each action shows ONE shared <img>. A native radio group
  // (always-visible chips) is the committed-state source of truth — keyboard,
  // touch, and AT operate it exactly like the radio-tab viewer, and the chips
  // are the only path to Diff. On top of that, the mouse gesture is a STATELESS
  // blink-compare layered on the same <img>:
  //   press-and-hold (mousedown) → the committed variant's COUNTERPART:
  //     baseline normally; actual when baseline is the committed variant
  //     ("show me the other one"; committed diff flips to baseline). A missing
  //     counterpart is a truthful no-op.
  //   release/leave/dragstart → revert to the checked radio's variant
  // There is deliberately NO hover behavior: hover swapped the image the moment
  // the pointer wandered in, so the resting state under the cursor was the OLD
  // screenshot. Rest = committed; press = intentional compare. Diff is off the
  // gesture too (secondary forensic view — its chip covers it).
  // The preview rewrites img.src plus the sight-only (aria-hidden) caption, so
  // the "Showing: {variant}" line always names the DISPLAYED image. It never
  // changes the checked radio, the img alt, any ARIA attribute, or any live
  // region — so pressing announces nothing by construction. The caption and the
  // checked radio are two different truths on purpose: the caption tracks what
  // is displayed (preview included), the checked radio tracks the committed
  // state AT operates on; during a press they diverge briefly — both remain
  // accurate. Do NOT "fix" that by moving radio.checked during preview: checked
  // is the single accessible source of committed state, and press-flapping it
  // would announce to AT and leave revert() nothing stable to revert to.
  //
  // The mouse listeners live on the .shot-stage wrapper rather than the
  // <img>, keeping the image itself handler-free and
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
      // touch / AT path mutates. Mouse preview reverts here on release, leave,
      // and dragstart.
      var committed = null;

      // Caption always names the DISPLAYED variant — committed or previewed.
      // The equality check is a cheap idempotence guard: writes are skipped
      // when the label is already showing (e.g. revert after a no-op press).
      function setCaption(variant) {
        if (!captionVariant) return;
        var label = VARIANT_LABELS[variant] || variant;
        if (captionVariant.textContent !== label) {
          captionVariant.textContent = label;
        }
      }

      function commit(variant) {
        if (!(variant in sources)) return;
        committed = variant;
        image.src = sources[variant];
        setCaption(variant);
      }

      // Show a variant WITHOUT committing (mouse preview). No-op when the variant
      // has no src, so a press whose counterpart is absent leaves the displayed
      // image AND the caption untouched (the caption stays truthful).
      function preview(variant) {
        if (!(variant in sources)) return;
        image.src = sources[variant];
        setCaption(variant);
      }

      function revert() {
        if (committed && committed in sources) {
          image.src = sources[committed];
          setCaption(committed);
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

      stage.addEventListener('mousedown', function () {
        preview(committed === 'baseline' ? 'actual' : 'baseline');
      });
      stage.addEventListener('mouseup', revert);
      stage.addEventListener('mouseleave', revert);
      // A press that turns into a native image drag can swallow the mouseup
      // (the pointer never "leaves" the stage), which would leave the preview
      // stuck. Native drag itself stays enabled — save-image is a platform
      // feature, not ours to suppress.
      stage.addEventListener('dragstart', revert);
    }

    document.querySelectorAll('.shot-interactive').forEach(function (fieldset) {
      setupInteractiveShots(fieldset);
    });
  })();

  // Two-dimension filter for the stories list, with a DIFFERENT granularity per
  // axis:
  //
  //   STATUS axis (the summary totals) works at TWO levels. Story ELIGIBILITY
  //   is the per-story ROLLUP (`totals.passed` = stories whose rollup status is
  //   `pass`): a story is status-eligible iff its own rollup `data-status`
  //   (emitted on the .story element) matches the active status, or the status
  //   filter is "all". Within an eligible story, non-matching actions are then
  //   PRUNED (hidden) so e.g. the `changed` view shows only the changed rows —
  //   and expand-all opens only those rows' screenshots. `skipped` actions are
  //   exempt from pruning: `skipped` exists on actions but not in the story
  //   rollup vocabulary, so pruning it could empty a story the pill counts (a
  //   dependency-blocked story is rollup `failed` with only `skipped` actions),
  //   and skipped rows are context for the failure, not mismatches. The
  //   exemption keeps the live-region visible-story count in agreement with the
  //   pill total on a status-only filter.
  //
  //   BREAKPOINT axis (the neutral pill row below the totals) is CONTAINER-level.
  //   A story is breakpoint-eligible iff it holds a [data-breakpoint] container
  //   matching the active breakpoint, or the bp filter is "all". Within a shown
  //   story, the non-matching [data-breakpoint] containers are hidden.
  //
  // Each axis is a set of native <button aria-pressed> single-select toggles
  // keyed to a `data-filter` / `data-breakpoint-filter` TOKEN, with its own
  // default-pressed "all" reset and its own single-pressed invariant.
  //
  // The two axes are ANDed: a story shows iff it is status-eligible (story
  // rollup) AND breakpoint-eligible (has a matching container). apply() is a
  // single top-down pass — story → [data-breakpoint] container — that reads BOTH
  // active tokens, so re-running it after either axis changes yields the current
  // intersection (no stale hides carried between axes). The breakpoint pills
  // render only for multi-breakpoint runs, so on a single-breakpoint run this
  // collapses to the status-only behavior with the bpFilter pinned at "all".
  //
  // Live-region updates are debounced by ~150ms; the visual hide/show is applied
  // immediately.
  (function () {
    var statusButtons = Array.prototype.slice.call(
      document.querySelectorAll('.summary-filter'),
    );
    if (statusButtons.length === 0) return;
    var bpButtons = Array.prototype.slice.call(
      document.querySelectorAll('.breakpoint-filter'),
    );
    var list = document.querySelector('.stories');
    var empty = document.querySelector('.stories-empty');
    if (!list || !empty) return;

    var stories = Array.prototype.slice.call(list.querySelectorAll('.story'));
    var total = stories.length;

    // Active token per axis; "all" means the axis imposes no constraint.
    var statusFilter = 'all';
    var bpFilter = 'all';

    var statusAllButton =
      statusButtons.find(function (button) {
        return button.getAttribute('data-filter') === 'all';
      }) || statusButtons[0];
    var bpAllButton = bpButtons.find(function (button) {
      return button.getAttribute('data-breakpoint-filter') === 'all';
    });

    // Cached for the zero-match disable + focus-rescue logic in apply(). The
    // scope word is now static markup ("screenshots" visible, " all screenshots"
    // sr-only), so the buttons are never relabelled per filter — the filter's own
    // live-region announcement already covers the context change.
    var expandButton = document.querySelector('[data-bulk-toggle="expand"]');
    var collapseButton = document.querySelector(
      '[data-bulk-toggle="collapse"]',
    );

    // Maintain a single-pressed invariant WITHIN one axis: exactly one button in
    // `buttons` carries aria-pressed="true".
    function setPressed(buttons, active) {
      buttons.forEach(function (button) {
        button.setAttribute(
          'aria-pressed',
          button === active ? 'true' : 'false',
        );
      });
    }

    // Apply BOTH active axes to one story:
    //   1. STATUS eligibility is story-level. The story is status-eligible when
    //      statusFilter is "all" or the story's own rollup data-status (the
    //      worst-across-breakpoints status emitted on the .story element) equals
    //      the TOKEN ("pass"), not a visible label. A status-ineligible story is
    //      hidden whole; its containers are never inspected, so they may carry
    //      stale hidden state (see the recompute invariant below).
    //   2. BREAKPOINT axis is container-level. Within a status-eligible story,
    //      each [data-breakpoint] container (a .breakpoint-group div OR the flat
    //      <ol class="actions">) is breakpoint-eligible when bpFilter is "all"
    //      or its data-breakpoint equals bpFilter. A non-matching container is
    //      hidden whole and its inner action prunes are CLEARED so a later
    //      reveal starts from a clean slate.
    //   3. STATUS pruning is action-level. Inside each breakpoint-eligible
    //      container, an action is hidden when statusFilter is active and the
    //      action's own data-status differs — EXCEPT `skipped` actions, which
    //      are never pruned. `skipped` is not a story-rollup status, so pruning
    //      it could empty a story the pill counts (a dependency-blocked story
    //      is rollup `failed` with only `skipped` actions); skipped rows are
    //      context for the failure, not mismatches.
    //   4. A container pruned to zero visible actions is hidden — a captioned
    //      empty list is a dead end. The story shows iff at least one container
    //      survives with a visible action.
    // Deliberate gate asymmetry under combined filters: the ROLLUP gates the
    // story, the exact match prunes actions. Under "changed at mobile", a story
    // whose rollup is `failed` stays hidden even if its mobile container holds
    // a `changed` action — that matches the pill's per-story rollup semantics.
    //
    // Recompute invariant: apply() re-runs this for EVERY story on every filter
    // change, unconditionally recomputing action.hidden in every breakpoint-
    // eligible container. Hidden stories and containers may carry stale inner
    // state by design; keep this pass memoization-free, or step 2's
    // clear-on-hide and the stale state inside status-hidden stories become
    // bugs.
    function applyToStory(story) {
      var statusMatches =
        statusFilter === 'all' ||
        story.getAttribute('data-status') === statusFilter;
      if (!statusMatches) {
        story.hidden = true;
        return false;
      }

      var containers = Array.prototype.slice.call(
        story.querySelectorAll('[data-breakpoint]'),
      );

      var storyVisible = false;
      containers.forEach(function (container) {
        var actions = Array.prototype.slice.call(
          container.querySelectorAll('.action'),
        );
        var bpMatches =
          bpFilter === 'all' ||
          container.getAttribute('data-breakpoint') === bpFilter;
        if (!bpMatches) {
          container.hidden = true;
          actions.forEach(function (action) {
            action.hidden = false;
          });
          return;
        }
        var containerVisible = false;
        actions.forEach(function (action) {
          var status = action.getAttribute('data-status');
          var pruned =
            statusFilter !== 'all' &&
            status !== statusFilter &&
            status !== 'skipped';
          action.hidden = pruned;
          if (!pruned) containerVisible = true;
        });
        container.hidden = !containerVisible;
        if (containerVisible) storyVisible = true;
      });

      story.hidden = !storyVisible;
      return storyVisible;
    }

    // The short "name width" label for a breakpoint pill's live-region echo
    // (e.g. "mobile 375"), read from the pressed pill's visible name + width.
    // The status pill's echo reuses the shared filterLabel helper. A missing or
    // "all" pill contributes nothing.
    function breakpointLabel(button) {
      if (!button) return '';
      if (button.getAttribute('data-breakpoint-filter') === 'all') return '';
      var nameEl = button.querySelector('.breakpoint-name');
      var name = nameEl ? nameEl.textContent.trim() : '';
      var dimsEl = button.querySelector('.breakpoint-dimensions');
      // The decorative "375×667" carries the width before the × glyph; take just
      // the width for the short form. Absent dimensions → bare name.
      var width = dimsEl ? dimsEl.textContent.split('×')[0].trim() : '';
      return width ? name + ' ' + width : name;
    }

    function apply(trigger) {
      var visible = 0;
      stories.forEach(function (story) {
        if (applyToStory(story)) visible += 1;
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
      // Disable both bulk-toggle buttons when the intersection matches zero
      // stories — there is nothing to expand/collapse. Runs on EVERY apply()
      // call, so a filter change that re-reveals stories re-enables them.
      if (expandButton) expandButton.disabled = hasNone;
      if (collapseButton) collapseButton.disabled = hasNone;

      statusRegion.writeDebounced(filterMessage(visible), 150);

      // Post-apply focus-loss guard: if filtering left focus on nothing, the
      // body, or inside a now-[hidden] subtree, return it to the control that
      // triggered this apply so keyboard users keep their place.
      var active = document.activeElement;
      if (
        trigger &&
        (!active ||
          active === document.body ||
          active === document.documentElement ||
          (active.closest && active.closest('[hidden]')))
      ) {
        trigger.focus();
      }
    }

    // Compose the live-region sentence for the current axis state (count =
    // visible stories after the intersection). Four combos:
    //   both all       → "Showing all N stories"
    //   status only    → "Showing {statusLabel}: N stories"
    //   breakpoint only → "Showing {breakpointLabel}: N stories"
    //   both           → "Showing {statusLabel} at {breakpointLabel}: N stories"
    // Singular/plural on stor(y|ies). aria-atomic replaces the whole sentence.
    function filterMessage(visible) {
      var noun = visible === 1 ? 'story' : 'stories';
      var statusActive = statusFilter !== 'all';
      var bpActive = bpFilter !== 'all';
      if (!statusActive && !bpActive) {
        return 'Showing all ' + total + ' ' + noun;
      }
      var statusLabel = filterLabel(
        statusButtons.find(function (button) {
          return button.getAttribute('aria-pressed') === 'true';
        }),
      );
      var bpLabel = breakpointLabel(
        bpButtons.find(function (button) {
          return button.getAttribute('aria-pressed') === 'true';
        }),
      );
      var scope;
      if (statusActive && bpActive) {
        scope = statusLabel + ' at ' + bpLabel;
      } else if (statusActive) {
        scope = statusLabel;
      } else {
        scope = bpLabel;
      }
      return 'Showing ' + scope + ': ' + visible + ' ' + noun;
    }

    statusButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        var token = button.getAttribute('data-filter');
        var isActive = button.getAttribute('aria-pressed') === 'true';
        // Re-clicking the active, non-"all" filter reverts that axis to "all".
        // Focus stays on the clicked button — it is in the summary row and never
        // hidden by its own action.
        if (isActive && token !== 'all') {
          setPressed(statusButtons, statusAllButton);
          statusFilter = 'all';
          apply(button);
          return;
        }
        // Re-clicking the already-active "all" button is a no-op.
        if (isActive) return;
        setPressed(statusButtons, button);
        statusFilter = token;
        apply(button);
      });
    });

    bpButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        var token = button.getAttribute('data-breakpoint-filter');
        var isActive = button.getAttribute('aria-pressed') === 'true';
        if (isActive && token !== 'all') {
          setPressed(bpButtons, bpAllButton);
          bpFilter = 'all';
          apply(button);
          return;
        }
        if (isActive) return;
        setPressed(bpButtons, button);
        bpFilter = token;
        apply(button);
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
  // No debounce: bulk-toggle fires once per click, so the live region is not
  // at risk of being flooded. The filter's 150ms debounce exists to coalesce a
  // rapid run of pill clicks; here a single click → single message is fine.
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
          active && active.closest && active.closest('details.shots[open]');
        if (openDetails) {
          var summary = openDetails.querySelector('summary');
          if (summary) summary.focus();
        }
      }
      var visibleStories = Array.prototype.slice.call(
        document.querySelectorAll('.story:not([hidden])'),
      );
      visibleStories.forEach(function (story) {
        // Only the rows surviving the active filter get toggled. The status
        // axis prunes non-matching actions ([hidden] on the .action) and the
        // breakpoint axis hides whole containers, so an action is "visible"
        // iff neither it nor its container is hidden. Excluding both keeps a
        // pruned row's panels closed — otherwise they would open here and
        // later appear pre-expanded when a filter change reveals them,
        // breaking the default-closed contract.
        var panels = Array.prototype.slice.call(
          story.querySelectorAll(
            '[data-breakpoint]:not([hidden]) .action:not([hidden]) details.shots',
          ),
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
      var noun = count === 1 ? 'story' : 'stories';
      var verb = shouldOpen ? 'Expanded' : 'Collapsed';
      // Echo the active STATUS-filter scope so the announcement carries context
      // for what was toggled (e.g. "Expanded passed in 3 stories"). The button
      // label itself is static ("Expand all screenshots"); only this live
      // announcement reflects the status filter. Read the pressed status pill at
      // click time via the shared filterLabel helper. No pressed button falls
      // back to "all".
      var pressed = document.querySelector(
        '.summary-filter[aria-pressed="true"]',
      );
      var name = filterLabel(pressed);
      bulkRegion.write(verb + ' ' + name + ' in ' + count + ' ' + noun);
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

  // Deep-link support for the CI comment. A URL like `…/index.html#story-3`
  // (built by tuffgal-action from the same `results.json` story ordinal that
  // template.ts renders as `id="story-<index>"`) lands the reader ON that story
  // with its screenshots already expanded — no scrolling or clicking through a
  // 34-row report to find the one that changed.
  //
  // On a matching hash we:
  //   1. Expand every VISIBLE screenshot disclosure in that story, reusing the
  //      bulk-toggle's own visibility predicate so a filtered-out row is not
  //      force-opened (default-closed contract). Setting `details.open` directly
  //      — not `.click()` — mirrors the bulk-toggle and avoids a toggle cascade.
  //   2. Move focus to the story `<li>` (tabindex="-1") so assistive tech
  //      announces the story prose rather than dropping the reader mid-list.
  //      `preventScroll` keeps focus from yanking the viewport before our own
  //      smooth scroll runs.
  //   3. Smooth-scroll the story to the top (respecting reduced-motion), so the
  //      expanded screenshots sit in view.
  //
  // Runs on initial load AND on `hashchange`, so following a second deep-link
  // within an already-open report re-targets without a reload.
  (function () {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

    function openStory(story) {
      // Same predicate the bulk-toggle uses: only rows surviving the active
      // filter (neither the action nor its breakpoint container hidden) get
      // opened, so a deep-link never resurrects a pruned row pre-expanded.
      var panels = Array.prototype.slice.call(
        story.querySelectorAll(
          '[data-breakpoint]:not([hidden]) .action:not([hidden]) details.shots',
        ),
      );
      panels.forEach(function (panel) {
        panel.open = true;
      });
      if (typeof story.focus === 'function') {
        story.focus({ preventScroll: true });
      }
      requestAnimationFrame(function () {
        story.scrollIntoView({
          behavior: reduce.matches ? 'instant' : 'smooth',
          block: 'start',
          inline: 'nearest',
        });
      });
    }

    function applyHash() {
      var hash = window.location.hash;
      // Only act on our own `#story-<n>` fragments; leave every other in-page
      // anchor (headings, skip link) to native browser behavior.
      if (!/^#story-\d+$/.test(hash)) return;
      var story = document.getElementById(hash.slice(1));
      if (story && story.classList.contains('story')) openStory(story);
    }

    applyHash();
    window.addEventListener('hashchange', applyHash);
  })();
})();
