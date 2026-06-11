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
  var status = document.querySelector('.story-filter-status');
  var list = document.querySelector('.stories');
  var empty = document.querySelector('.stories-empty');
  if (!status || !list || !empty) return;

  var stories = Array.prototype.slice.call(list.querySelectorAll('.story'));
  var radios = Array.prototype.slice.call(
    fieldset.querySelectorAll('input[type="radio"]'),
  );
  var total = stories.length;
  var liveTimer = null;

  function apply(radio) {
    var value = radio.value;
    var name = radio.getAttribute('data-filter-name') || value;
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

    if (liveTimer !== null) {
      clearTimeout(liveTimer);
    }
    liveTimer = setTimeout(function () {
      status.textContent = message;
      liveTimer = null;
    }, 150);
  }

  radios.forEach(function (radio) {
    radio.addEventListener('change', function () {
      apply(radio);
    });
  });
})();
