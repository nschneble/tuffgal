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
