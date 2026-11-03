import Foundation

/// Builds the page script that fills an employer application in Chrome.
/// It only touches empty, visible, clearly labeled contact, education, and
/// link fields, skips anything that needs the applicant's judgment, and never
/// submits. Filled fields glow briefly so they are easy to review. When a
/// role-tuned resume is given, it goes into the empty resume upload field.
enum Autofill {
    struct Result {
        let count: Int
        let fields: [String]
        let attached: Bool
        let embeddedForm: URL?
    }

    static func script(profile: [String: String], resume: (name: String, pdf: Data)? = nil) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: profile)) ?? Data("{}".utf8)
        let encoded = data.base64EncodedString()
        let resumeName = Data((resume?.name ?? "").utf8).base64EncodedString()
        let resumeData = resume?.pdf.base64EncodedString() ?? ""
        return """
        (() => {
          const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('\(encoded)'), c => c.charCodeAt(0))));
          const parts = (p.name || '').trim().split(/\\s+/);
          const values = {email: p.email, phone: p.phone, linkedin: p.linkedin, github: p.github, website: p.website,
            first: parts[0] || '', last: parts.length > 1 ? parts.slice(1).join(' ') : '', name: p.name, address: p.address,
            city: p.city, state: p.state, postal: p.postal_code, school: p.school, degree: p.degree, graduation: p.graduation};
          const rules = [['email', /e ?mail/], ['phone', /phone|mobile|cellular/], ['linkedin', /linkedin/], ['github', /github/],
            ['website', /website|portfolio|personal (site|url|page)/], ['first', /first name|given name|^first$/],
            ['last', /last name|family name|surname|^last$/], ['name', /full name|your name|legal name|^name$/],
            ['address', /street address|address line 1|address 1|^address$/], ['city', /(^| )city( |$)|town/],
            ['state', /(^| )state( |$)|province/], ['postal', /zip|postal code|postcode/],
            ['school', /school|university|college/], ['degree', /degree/], ['graduation', /graduat|expected completion/]];
          // Questions only the applicant should answer, and fields about other people.
          const judgment = /sponsor|visa|will you|are you|do you|have you|race|ethnic|gender|pronoun|disab|veteran|authori[sz]|salary|compensation|password|(^| )referr|hear about|why |reference|emergency|supervisor|manager|guardian|parent|high school|extension/;
          const norm = s => (s || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\\s+/g, ' ').trim();
          const text = id => (document.getElementById(id) || {}).innerText;
          // A wrapper's label counts only when the wrapper holds this one field.
          const wrapperLabel = e => { const w = e.parentElement; return w && w.querySelectorAll('input, select, textarea').length === 1 ? (w.querySelector('label') || {}).innerText : ''; };
          const label = e => norm([e.getAttribute('autocomplete'), e.getAttribute('aria-label'),
            (e.getAttribute('aria-labelledby') || '').split(/\\s+/).map(text).join(' '), e.getAttribute('placeholder'), e.name, e.id,
            [...(e.labels || [])].map(x => x.innerText).join(' '), (e.closest('label') || {}).innerText, wrapperLabel(e)].filter(Boolean).join(' '));
          const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          const filled = [];
          for (const e of document.querySelectorAll('input')) {
            const type = (e.type || 'text').toLowerCase();
            if (!['text', 'email', 'tel', 'url', 'number'].includes(type) || !e.getClientRects().length || e.disabled || e.readOnly || (e.value || '').trim()) continue;
            const l = label(e);
            if (!l || judgment.test(l)) continue;
            const rule = rules.find(([key, pattern]) => values[key] && pattern.test(l));
            if (!rule) continue;
            setValue.call(e, values[rule[0]]);
            for (const name of ['input', 'change', 'blur']) e.dispatchEvent(new Event(name, {bubbles: true}));
            const glow = e.style.boxShadow;
            e.style.transition = 'box-shadow .4s ease';
            e.style.boxShadow = '0 0 0 3px rgba(16, 183, 127, .55)';
            setTimeout(() => { e.style.boxShadow = glow; }, 2600);
            filled.push(rule[0]);
          }
          // Attach the role-tuned resume to the empty resume upload, never to
          // cover letter, transcript, or portfolio uploads.
          let attached = false;
          const pdf = '\(resumeData)';
          if (pdf) {
            const uploads = [...document.querySelectorAll('input[type=file]')].filter(i => !i.disabled && !(i.files && i.files.length));
            const other = /cover|transcript|portfolio|writing sample|photo|headshot/;
            const target = uploads.find(i => /resume|(^| )cv( |$)|curriculum/.test(label(i)) && !other.test(label(i)))
              || (uploads.length === 1 && !other.test(label(uploads[0])) ? uploads[0] : null);
            if (target && (!target.accept || /pdf|application\\/|\\*/.test(target.accept))) {
              const name = new TextDecoder().decode(Uint8Array.from(atob('\(resumeName)'), c => c.charCodeAt(0)));
              const files = new DataTransfer();
              files.items.add(new File([Uint8Array.from(atob(pdf), c => c.charCodeAt(0))], name, {type: 'application/pdf'}));
              target.files = files.files;
              for (const event of ['input', 'change']) target.dispatchEvent(new Event(event, {bubbles: true}));
              attached = true;
            }
          }
          const frame = filled.length || attached ? null : [...document.querySelectorAll('iframe')].find(f => /greenhouse|lever|ashby|workday|smartrecruiters|icims|jobvite/.test(f.src || ''));
          return JSON.stringify({count: filled.length, fields: filled, attached, embedded: frame ? frame.src : ''});
        })()
        """
    }

    static func parse(_ output: String?) -> Result? {
        guard let data = output?.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let count = object["count"] as? Int else { return nil }
        let embedded = (object["embedded"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
        return Result(count: count, fields: object["fields"] as? [String] ?? [], attached: object["attached"] as? Bool ?? false, embeddedForm: embedded)
    }
}
