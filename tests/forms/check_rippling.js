// Values on tests/forms/rippling.html after a fill (the made-up plan lives in Austin, TX).
JSON.stringify({
  city: document.getElementById('city').value,
  gender: document.getElementById('gender').textContent.trim(),
  race: document.getElementById('race').value,
  veteran: document.getElementById('vet').textContent.trim(),
  work_in: (document.querySelector('input[name=work_in]:checked') || {}).value || '',
})
