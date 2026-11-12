(() => {
  const text = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
  const dates = [...document.querySelectorAll('[data-automation-id="dateInputWrapper"]')].map(w => {
    const field = w.closest('[data-automation-id^="formField"]');
    const block = w.closest('[role="group"]');
    return `${text(block && block.querySelector('h4'))} ${text(field.querySelector('label'))} = ${[...w.querySelectorAll('.shown')].map(text).join('/')}`;
  });
  const skills = [...document.querySelectorAll('[data-automation-id="formField-skills"] [data-automation-id="selectedItem"]')].map(text);
  const gpa = [...document.querySelectorAll('[data-automation-id="formField-gpa"] input')].map(i => i.value);
  const current = [...document.querySelectorAll('[data-automation-id="formField-currentlyWorkHere"] input')].map(i => i.checked);
  return { dates, skills, gpa, current };
})()
