// Values on tests/forms/questions.html after a fill.
JSON.stringify({
  fullname: document.getElementById('fullname').value,
  rolla: document.getElementById('rolla').value,
  spouse: (document.querySelector('input[name=spouse]:checked') || {}).value || '',
  avail: document.getElementById('avail').value,
  startpick: [...document.querySelectorAll('input[name=startpick]:checked')].map(box => box.value),
  reel: document.getElementById('reel').value,
  verify: (document.querySelector('input[name=verify]:checked') || {}).value || '',
  campaign: document.getElementById('campaign').checked,
  gradyear: document.getElementById('gradyear').value,
  gradmonth: document.getElementById('gradmonth').value,
  more: document.getElementById('more').value.slice(0, 120),
  else: document.getElementById('else').value.slice(0, 120),
  langs: document.getElementById('langs').value.slice(0, 120),
})
