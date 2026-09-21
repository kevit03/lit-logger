// Calorie estimation and profile helpers for the calorie tracker feature.
//
// Pure logic lives here so it is testable headlessly (see test/calorie.test.js):
// clarifying-question selection, query assembly, TDEE/budget math, and the
// Nutritionix -> USDA fallback chain. DOM and chrome.storage plumbing live in
// popup/popup.js; CalorieKeys below only wraps chrome.storage.local (never
// .sync, since these are personal API credentials, not data to carry
// cross-device through a Google-synced store).
const CalorieTracker = (() => {
  // Each rule's `questions` are asked in order, then a shared "anything else"
  // question is appended by getClarifyingQuestions. Matching is deliberately
  // simple keyword/regex sniffing, not real NLU: it only has to narrow down
  // common vague entries enough to build a specific lookup query.
  const FOOD_RULES = [
    { matches: /\bbread\b|\btoast\b/, questions: [
      { key: 'type', prompt: 'What kind of bread — white, wheat, sourdough, rye, whole grain?' },
      { key: 'qty', prompt: 'How many slices?' }
    ] },
    { matches: /\brice\b/, questions: [
      { key: 'type', prompt: 'What kind of rice — white, brown, jasmine, basmati, fried rice?' },
      { key: 'qty', prompt: 'About how many cups, cooked?' }
    ] },
    { matches: /\bchicken\b/, questions: [
      { key: 'cut', prompt: 'What cut/prep — breast, thigh, wing, fried, grilled, rotisserie?' },
      { key: 'qty', prompt: 'About how many ounces or pieces?' }
    ] },
    { matches: /\bpizza\b/, questions: [
      { key: 'type', prompt: 'What kind of pizza — cheese, pepperoni, veggie, thin crust, deep dish?' },
      { key: 'qty', prompt: 'How many slices?' }
    ] },
    { matches: /\bsandwich\b|\bsub\b/, questions: [
      { key: 'fillings', prompt: 'What\'s on it — bread type, meat/cheese, spreads?' }
    ] },
    { matches: /\bsalad\b/, questions: [
      { key: 'contents', prompt: 'What\'s in it, and what dressing (and about how much)?' }
    ] },
    { matches: /\bpasta\b|\bspaghetti\b|\bnoodles?\b/, questions: [
      { key: 'type', prompt: 'What kind of pasta and sauce?' },
      { key: 'qty', prompt: 'About how many cups?' }
    ] },
    { matches: /\beggs?\b/, questions: [
      { key: 'prep', prompt: 'How were the eggs prepared — fried, scrambled, boiled, with oil/butter?' },
      { key: 'qty', prompt: 'How many eggs?' }
    ] },
    { matches: /\bburger\b/, questions: [
      { key: 'type', prompt: 'What kind — beef, chicken, veggie patty — and single or double?' },
      { key: 'toppings', prompt: 'Cheese, bacon, sauces, bun type?' }
    ] },
    { matches: /\bsmoothie\b|\bshake\b/, questions: [
      { key: 'contents', prompt: 'What\'s blended in it (fruits, milk/yogurt, protein powder, sweetener)?' },
      { key: 'qty', prompt: 'About how many ounces?' }
    ] },
    { matches: /\bcereal\b/, questions: [
      { key: 'type', prompt: 'What brand/kind of cereal?' },
      { key: 'qty', prompt: 'About how many cups, and what milk (and how much)?' }
    ] },
    { matches: /\bmilk\b/, questions: [
      { key: 'type', prompt: 'What kind — whole, 2%, skim, oat, almond, soy?' },
      { key: 'qty', prompt: 'About how many cups or ounces?' }
    ] },
    { matches: /\bcoffee\b|\blatte\b|\bcappuccino\b/, questions: [
      { key: 'type', prompt: 'What kind — black coffee, latte, cappuccino, cold brew?' },
      { key: 'milk', prompt: 'What milk and how much, and any sugar/syrup?' },
      { key: 'size', prompt: 'What size (small/medium/large, or oz)?' }
    ] },
    { matches: /\bburrito\b|\btaco\b/, questions: [
      { key: 'fillings', prompt: 'What\'s in it — protein, rice/beans, cheese, sour cream, guac?' },
      { key: 'qty', prompt: 'How many?' }
    ] },
    { matches: /\bsoup\b/, questions: [
      { key: 'type', prompt: 'What kind of soup, and about how many cups?' }
    ] },
    { matches: /\byogurt\b/, questions: [
      { key: 'type', prompt: 'What kind — Greek, regular, flavored, plain, fat %?' },
      { key: 'qty', prompt: 'About how many ounces or cups, and any toppings?' }
    ] },
    { matches: /\bsteak\b/, questions: [
      { key: 'cut', prompt: 'What cut, and about how many ounces?' },
      { key: 'prep', prompt: 'How was it cooked (grilled, pan-fried in butter, etc.)?' }
    ] },
    { matches: /\bfries\b/, questions: [
      { key: 'size', prompt: 'About how much — small, medium, large, or a cup estimate?' }
    ] },
    { matches: /\bsushi\b/, questions: [
      { key: 'type', prompt: 'What rolls/pieces, and about how many?' }
    ] }
  ];

  const SIDES_QUESTION = { key: 'sides', prompt: 'Anything else you had with it? (sides, drink, condiments — or say "no")', optional: true };
  const GENERIC_QUESTION = { key: 'details', prompt: 'About how much (cups/oz/pieces), and the exact kind or brand, so I can look it up accurately?' };

  function getClarifyingQuestions(text) {
    const lower = (text || '').toLowerCase();
    const rule = FOOD_RULES.find(r => r.matches.test(lower));
    const questions = (rule ? rule.questions : [GENERIC_QUESTION]).slice();
    questions.push(SIDES_QUESTION);
    return questions;
  }

  // True when the text matches one of the known FOOD_RULES keywords. Callers
  // use this to decide between the specific clarifying-question flow (known
  // foods) and the AI classify/estimate flow (impromptu, unrecognized text).
  function hasKnownFoodRule(text) {
    const lower = (text || '').toLowerCase();
    return FOOD_RULES.some(r => r.matches.test(lower));
  }

  // Pulls a leading count off free text, e.g. "3 whole grain" -> { qty: 3,
  // rest: "whole grain" }. The AI path looks up calories for ONE unit of
  // `rest` and multiplies by `qty` itself, rather than trusting the model to
  // do the arithmetic. No leading number just means one unit of the item.
  function extractLeadingQuantity(text) {
    const s = String(text || '').trim();
    const m = s.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (m) return { qty: parseFloat(m[1]), rest: m[2].trim() };
    return { qty: 1, rest: s };
  }

  function isSkip(answer) {
    return !answer || /^(no|none|nothing|nope|n\/a|skip)\.?$/i.test(answer.trim());
  }

  // Folds the clarifying answers back into one natural-language sentence fit
  // to hand a nutrition API, e.g. "2 slices wheat bread with butter and jam".
  function buildFollowupQuery(originalText, answers) {
    const a = answers || {};
    // `details` (the old generic "how much, and the exact kind or brand?"
    // catch-all answer) replaces originalText in the lead rather than
    // supplementing it -- otherwise a plain re-statement like "crab" for
    // both the original text and the details answer produced "crab crab".
    const lead = [a.qty, a.type || a.cut || a.contents || a.fillings || a.details || originalText].filter(Boolean).join(' ');
    const parts = [lead || originalText];
    if (a.prep) parts.push(a.prep);
    if (a.toppings) parts.push('with ' + a.toppings);
    if (a.milk) parts.push('with ' + a.milk);
    if (a.size) parts.push(a.size);
    if (!isSkip(a.sides)) parts.push('and ' + a.sides.trim());
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  async function queryNutritionix(query, credentials, doFetch) {
    const res = await doFetch('https://trackapi.nutritionix.com/v2/natural/nutrients', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-app-id': credentials.nutritionixAppId,
        'x-app-key': credentials.nutritionixApiKey
      },
      body: JSON.stringify({ query })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const foods = Array.isArray(data && data.foods) ? data.foods : [];
    if (foods.length === 0) return null;
    const calories = Math.round(foods.reduce((sum, f) => sum + (Number(f.nf_calories) || 0), 0));
    const breakdown = foods.map(f => ({
      name: f.food_name,
      calories: Math.round(Number(f.nf_calories) || 0),
      servingQty: f.serving_qty,
      servingUnit: f.serving_unit
    }));
    return { calories, breakdown, source: 'nutritionix', approximate: false };
  }

  const GRAM_ESTIMATES = {
    slice: 30, slices: 30, oz: 28.35, ounce: 28.35, ounces: 28.35,
    tbsp: 15, tablespoon: 15, tablespoons: 15, piece: 100, pieces: 100, egg: 50, eggs: 50,
    // Direct weight/volume units: these are a hotfix for a real bug -- when a
    // food isn't matched by Nutritionix's natural-language parsing (which
    // handles any unit fine) and falls to this per-clause USDA tier, a plain
    // gram/kg/lb/ml/l amount was being treated as a COUNT of 100g "items"
    // instead of the actual weight itself, e.g. "200g chicken" computed as
    // 200 x 100g = 20,000g (a 100x overestimate) instead of 200g. Grams and
    // milliliters convert 1:1 (ml approximated as water density, which is
    // close enough for most foods/drinks at this tier's precision).
    g: 1, gram: 1, grams: 1,
    kg: 1000, kilogram: 1000, kilograms: 1000,
    lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
    ml: 1, milliliter: 1, milliliters: 1,
    l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000
  };

  // "1 cup" is not one weight -- a cup of milk (~240g) is nearly twice a cup
  // of cooked rice (~158g) or pasta (~140g). Verified against real USDA/
  // nutrition-database figures (see test/calorie.test.js): treating every
  // "cup" as 240g overestimated a cup of rice by ~53% and pasta by ~72%.
  // Checked by food keyword since these are exactly the FOOD_RULES
  // categories ("how many cups?") most likely to hit this unit.
  const CUP_GRAMS_BY_FOOD = {
    rice: 158,
    pasta: 140, spaghetti: 140, noodle: 140, noodles: 140, macaroni: 140,
    oats: 234, oatmeal: 234,
    quinoa: 185,
    beans: 170,
    cereal: 30
  };
  const DEFAULT_CUP_GRAMS = 240; // milk, smoothies, liquids, and anything else unrecognized

  function cupGramsFor(term) {
    const lower = term.toLowerCase();
    const key = Object.keys(CUP_GRAMS_BY_FOOD).find(k => lower.includes(k));
    return key ? CUP_GRAMS_BY_FOOD[key] : DEFAULT_CUP_GRAMS;
  }

  function splitFoodTerms(query) {
    return String(query || '').split(/\s+(?:and|with)\s+/i).map(s => s.trim()).filter(Boolean);
  }

  function estimateGrams(term) {
    // "\b" doesn't split a digit from an immediately-following letter (both
    // are word characters), so "200g" alone never matched the unit regex --
    // only the (rarer) spaced-out "200 g" did. Inserting a space first makes
    // both forms parse the same way.
    const normalized = String(term || '').replace(/(\d)([a-zA-Z])/g, '$1 $2');
    const qtyMatch = normalized.match(/^(\d+(?:\.\d+)?)/);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 1;
    const unitMatch = normalized.toLowerCase().match(
      /\b(slices?|cups?|oz|ounces?|tbsp|tablespoons?|pieces?|eggs?|kilograms?|kg|grams?|g|pounds?|lbs?|milliliters?|ml|liters?|litres?|l)\b/
    );
    if (!unitMatch) return qty * 100;
    const unit = unitMatch[1].toLowerCase();
    if (unit === 'cup' || unit === 'cups') return qty * cupGramsFor(normalized);
    return qty * (GRAM_ESTIMATES[unit] || 100);
  }

  // USDA FoodData Central has no natural-language endpoint, so each clause of
  // the query is searched separately and scaled by a rough gram estimate from
  // its quantity word. Coarser than Nutritionix by design; callers should
  // mark it approximate to the user.
  async function queryUSDA(query, credentials, doFetch) {
    const terms = splitFoodTerms(query);
    let total = 0;
    const breakdown = [];
    let matchedAny = false;
    for (const term of terms) {
      const searchTerm = term.replace(/^\d+(?:\.\d+)?\s*/, '').trim() || term;
      const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?api_key=' + encodeURIComponent(credentials.usdaApiKey)
        + '&query=' + encodeURIComponent(searchTerm) + '&pageSize=1';
      let res;
      try {
        res = await doFetch(url);
      } catch (e) {
        continue;
      }
      if (!res.ok) continue;
      const data = await res.json();
      const food = data && Array.isArray(data.foods) ? data.foods[0] : null;
      if (!food) continue;
      const nutrients = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
      const energy = nutrients.find(n => n.nutrientId === 1008 || /^energy$/i.test(n.nutrientName || ''));
      if (!energy) continue;
      matchedAny = true;
      const grams = estimateGrams(term);
      const calories = Math.round((Number(energy.value) || 0) * grams / 100);
      total += calories;
      breakdown.push({ name: food.description, calories, gramsEstimate: Math.round(grams) });
    }
    if (!matchedAny) return null;
    return { calories: total, breakdown, source: 'usda', approximate: true };
  }

  // Queries every configured provider (rather than stopping at the first
  // success) so results can be cross-checked against each other -- a single
  // bad USDA keyword match (e.g. "egg" resolving to "Egg white, raw" at
  // ~52 kcal/100g instead of a whole egg) gets caught when Nutritionix or
  // Gemini disagrees with it, instead of being trusted blindly. Returns
  // { calories: null, source: 'manual' } only once every configured option
  // has been tried, so the caller can fall back to asking the user directly.
  async function estimateCalories({ query, credentials, fetchImpl }) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const creds = credentials || {};
    if (!doFetch) return { calories: null, source: 'manual', reason: 'no-fetch' };

    const candidates = [];
    if (creds.nutritionixAppId && creds.nutritionixApiKey) {
      try {
        const result = await queryNutritionix(query, creds, doFetch);
        if (result) candidates.push(result);
      } catch (e) { /* this source just doesn't contribute a candidate */ }
    }
    if (creds.usdaApiKey) {
      try {
        const result = await queryUSDA(query, creds, doFetch);
        if (result) candidates.push(result);
      } catch (e) { /* this source just doesn't contribute a candidate */ }
    }
    if (creds.geminiApiKey) {
      try {
        const result = await queryGeminiCalorieLookup(query, creds, doFetch);
        if (result) candidates.push({ calories: result.calories, summary: result.summary, source: 'ai-search', approximate: true });
      } catch (e) { /* this source just doesn't contribute a candidate */ }
    }

    if (candidates.length === 0) return { calories: null, source: 'manual', reason: 'no-match' };
    if (candidates.length === 1) return candidates[0];
    return reconcileCandidates(query, candidates, creds, doFetch);
  }

  // Two estimates "agree" if neither is more than AGREEMENT_RATIO times the
  // other -- loose enough to tolerate normal rounding/serving-size variance
  // between sources, tight enough to catch a wrong food match (e.g. egg
  // white vs. whole egg, which differ by ~3x).
  const AGREEMENT_RATIO = 1.6;

  function candidatesAgree(a, b) {
    if (a === 0 && b === 0) return true;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo > 0 && hi / lo <= AGREEMENT_RATIO;
  }

  // Cross-checks multiple providers' estimates for the same query against
  // each other. If any two agree, their average is trusted as a corroborated
  // result. If nobody agrees (a real conflict, like the egg-white mismatch),
  // Gemini is asked to adjudicate using the raw candidate numbers -- and,
  // since it has search grounding, real nutrition data -- rather than
  // silently trusting whichever source happened to answer first.
  async function reconcileCandidates(query, candidates, credentials, doFetch) {
    for (const c of candidates) {
      const agreeing = candidates.filter(o => candidatesAgree(c.calories, o.calories));
      if (agreeing.length >= 2) {
        return {
          calories: Math.round(agreeing.reduce((sum, x) => sum + x.calories, 0) / agreeing.length),
          source: 'cross-checked',
          approximate: agreeing.some(x => x.approximate),
          checkedAgainst: candidates.map(x => ({ source: x.source, calories: x.calories }))
        };
      }
    }

    if (credentials.geminiApiKey) {
      try {
        const arbitrated = await queryGeminiArbitrate(query, candidates, credentials, doFetch);
        if (arbitrated) {
          return {
            calories: arbitrated.calories,
            source: 'ai-arbitrated',
            approximate: true,
            summary: arbitrated.summary,
            checkedAgainst: candidates.map(c => ({ source: c.source, calories: c.calories }))
          };
        }
      } catch (e) { /* fall through to the priority-based pick below */ }
    }

    // No consensus and no AI available to break the tie: Nutritionix's
    // natural-language matching is generally more reliable for free-text
    // queries than USDA's single-keyword search, so prefer it, then the web-
    // grounded AI lookup, then USDA last.
    const PRIORITY = ['nutritionix', 'ai-search', 'usda'];
    const fallback = candidates.slice().sort((a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source))[0];
    return Object.assign({}, fallback, { checkedAgainst: candidates.map(c => ({ source: c.source, calories: c.calories })) });
  }

  // Called only when the configured providers disagree with each other.
  // Gives Gemini the raw conflicting numbers (plus search grounding) and
  // asks it to either pick the right one or correct it outright.
  async function queryGeminiArbitrate(query, candidates, credentials, doFetch) {
    const list = candidates.map(c => c.source + ': ' + c.calories + ' kcal').join('; ');
    const prompt = 'Nutrition lookups disagreed with each other for this food log entry: "' + String(query || '') + '". '
      + 'Candidate estimates from different sources: ' + list + '. Decide which candidate is most plausible for a '
      + 'normal serving, or use Google Search to find real nutrition data and give your own corrected total if none '
      + 'of them look right. Respond with ONLY strict JSON, no markdown fences, matching exactly this shape: '
      + '{"calories": <integer total kcal>, "summary": "<short string, under 20 words, saying which source you trusted or why you corrected it>"}.';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL
      + ':generateContent?key=' + encodeURIComponent(credentials.geminiApiKey);
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: GEMINI_SEARCH_TOOLS
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = extractGeminiJson(extractGeminiText(data));
    if (!parsed || !isFinite(Number(parsed.calories))) return null;
    return { calories: Math.round(Number(parsed.calories)), summary: String(parsed.summary || '').trim() };
  }

  const GEMINI_MODEL = 'gemini-2.5-flash';
  // Gemini's built-in Google Search grounding tool: lets the model look
  // real nutrition data up on the web instead of relying solely on what it
  // already "knows", for foods neither Nutritionix nor USDA recognized.
  const GEMINI_SEARCH_TOOLS = [{ google_search: {} }];

  function extractGeminiText(data) {
    return (data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text) || null;
  }

  // The prompt asks for "ONLY strict JSON", but that's not enforced the way
  // generationConfig.responseMimeType would (that's left off here since it
  // isn't reliably compatible with the google_search tool). For offbeat or
  // ambiguous input, the model is more likely to wrap the JSON in a
  // sentence or a markdown fence instead of returning it bare -- a plain
  // `JSON.parse` on the whole trimmed string broke on exactly that, which is
  // what made "random" inputs silently fall through to manual entry more
  // than they should have. Stripping fences first, then falling back to
  // pulling out the first {...} block, recovers those cases too.
  function extractGeminiJson(raw) {
    if (!raw) return null;
    const cleaned = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (e) { /* fall through to pulling out an embedded {...} block */ }
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      return null;
    }
  }

  // Used for the known-food path once Nutritionix/USDA have both failed to
  // match `query` (which already states quantity, e.g. "2 slices wheat
  // bread"). Search grounding is enabled so Gemini can look up real
  // nutrition data instead of guessing. Returns null on any malformed/
  // unparsable response so estimateCalories falls through to manual entry.
  async function queryGeminiCalorieLookup(query, credentials, doFetch) {
    const prompt = 'You are a nutrition estimation assistant embedded in a calorie tracker app. Estimate the '
      + 'total calories (kcal) for exactly this food log entry, respecting any quantities/amounts already stated '
      + 'in it: "' + String(query || '') + '". If you are not confident from general knowledge, use Google Search '
      + 'to find real nutrition data before answering. Respond with ONLY strict JSON, no markdown fences, matching '
      + 'exactly this shape: {"calories": <integer total kcal>, "summary": "<short string, under 15 words>"}.';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL
      + ':generateContent?key=' + encodeURIComponent(credentials.geminiApiKey);
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: GEMINI_SEARCH_TOOLS
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = extractGeminiJson(extractGeminiText(data));
    if (!parsed || !isFinite(Number(parsed.calories))) return null;
    return { calories: Math.round(Number(parsed.calories)), summary: String(parsed.summary || '').trim() };
  }

  // `term` has already had any leading quantity stripped off by
  // extractLeadingQuantity; `qty` (>1 when the user gave a count, e.g. the
  // "3" in "3 whole grain") tells Gemini to price ONE unit only -- the
  // caller does the multiplication so the app's arithmetic doesn't depend on
  // the model getting multiplication right.
  function buildAiFoodPrompt(term, qty) {
    return 'You are a nutrition estimation assistant embedded in a calorie tracker app. The user typed the '
      + 'following free-text log entry, which may or may not describe food or drink:\n\n"' + String(term || '') + '"\n\n'
      + (qty !== 1 ? 'The user is logging ' + qty + ' of this item; estimate calories for ONE single unit/serving '
        + 'only -- the app will multiply it by the quantity itself.\n\n' : '')
      + 'Decide whether this describes something edible (food or drink) that could reasonably be logged as a '
      + 'calorie entry. If you are not confident from general knowledge, use Google Search to look up real '
      + 'nutrition data before answering. Respond with ONLY strict JSON, no markdown fences, matching exactly '
      + 'this shape:\n'
      + '{"isFood": true or false, "calories": <integer kcal for ONE serving/unit, or null if isFood is false>, "summary": "<short string>"}\n\n'
      + 'If isFood is true: estimate calories for a single reasonable serving/unit of what was described. Put a '
      + 'short (under 15 words) description of what you assumed (and whether you searched) into "summary".\n'
      + 'If isFood is false: set "calories" to null and put a short (under 15 words) reason it is not food into "summary".';
  }

  // Calls Gemini to both classify ("is this even food?") and, when it is,
  // estimate calories in one round trip -- this is the path for impromptu
  // text that doesn't match any FOOD_RULES keyword, so a rigid clarifying
  // question wouldn't know what to ask. Search grounding is enabled so it
  // can look obscure items up on the web rather than guessing. Returns null
  // on any malformed/unparsable response so the caller can fall back
  // gracefully.
  async function queryGeminiFoodCheck(term, qty, credentials, doFetch) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL
      + ':generateContent?key=' + encodeURIComponent(credentials.geminiApiKey);
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildAiFoodPrompt(term, qty) }] }],
        tools: GEMINI_SEARCH_TOOLS
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = extractGeminiJson(extractGeminiText(data));
    if (!parsed || typeof parsed.isFood !== 'boolean') return null;
    const perUnitCalories = parsed.isFood ? Math.round(Number(parsed.calories) || 0) : null;
    return { isFood: parsed.isFood, perUnitCalories, summary: String(parsed.summary || '').trim() };
  }

  // Public entry point for the AI classify/estimate path. Normalizes every
  // outcome (no key configured, network/parse failure, "not food", "food")
  // into one shape so popup.js can branch on `isFood` without knowing about
  // Gemini specifically. `isFood: null` means "AI unavailable/errored" --
  // callers should fall back to the regular clarifying-question flow.
  // Handles a leading quantity itself, e.g. "3 whole grain" looks up
  // calories for one unit of "whole grain" and multiplies the total by 3.
  async function estimateCaloriesWithAI({ text, credentials, fetchImpl }) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const creds = credentials || {};
    if (!doFetch || !creds.geminiApiKey) return { isFood: null, calories: null, source: 'manual', reason: 'no-ai' };
    const { qty, rest } = extractLeadingQuantity(text);
    try {
      const result = await queryGeminiFoodCheck(rest, qty, creds, doFetch);
      if (!result) return { isFood: null, calories: null, source: 'manual', reason: 'ai-error' };
      if (!result.isFood) return { isFood: false, calories: null, summary: result.summary, source: 'manual', reason: 'not-food' };
      const total = Math.round(result.perUnitCalories * qty);
      const summary = qty !== 1
        ? qty + ' x ~' + result.perUnitCalories + ' kcal' + (result.summary ? ' -- ' + result.summary : '')
        : result.summary;
      return { isFood: true, calories: total, summary, source: 'ai', approximate: true };
    } catch (e) {
      return { isFood: null, calories: null, source: 'manual', reason: 'ai-error' };
    }
  }

  const ACTIVITY_MULTIPLIERS = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    veryActive: 1.9
  };

  const LB_TO_KG = 0.45359237;
  const IN_TO_CM = 2.54;
  const MIN_BUDGET = 1200;

  // Mifflin-St Jeor BMR, scaled by activity level, minus a deficit. weightLb
  // and heightIn are the units the settings form collects; converted here so
  // the arithmetic itself works in the metric units the formula expects.
  function estimateCalorieBudget({ weightLb, heightIn, age, sex, activityLevel, deficit }) {
    const w = Number(weightLb) * LB_TO_KG;
    const h = Number(heightIn) * IN_TO_CM;
    const a = Number(age);
    if (!isFinite(w) || !isFinite(h) || !isFinite(a) || w <= 0 || h <= 0 || a <= 0) return null;
    const bmr = 10 * w + 6.25 * h - 5 * a + (sex === 'female' ? -161 : 5);
    const multiplier = ACTIVITY_MULTIPLIERS[activityLevel] || ACTIVITY_MULTIPLIERS.sedentary;
    const tdee = bmr * multiplier;
    const deficitAmount = isFinite(Number(deficit)) ? Number(deficit) : 500;
    const suggestedBudget = Math.max(MIN_BUDGET, Math.round(tdee - deficitAmount));
    return { bmr: Math.round(bmr), tdee: Math.round(tdee), suggestedBudget };
  }

  // chrome.storage.local only: API keys and body-profile inputs are personal
  // credentials/PII, not tracker data, so they deliberately never go through
  // chrome.storage.sync the way logs and metrics do.
  const KEYS_STORAGE_KEY = 'pt_calorie_keys';
  const PROFILE_STORAGE_KEY = 'pt_calorie_profile';

  function getLocalArea() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local;
    return {
      get: (keys, cb) => {
        const result = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
          if (typeof localStorage !== 'undefined') {
            const val = localStorage.getItem(k);
            if (val !== null && val !== undefined) {
              try { result[k] = JSON.parse(val); } catch (e) { /* ignore */ }
            }
          }
        });
        cb(result);
      },
      set: (items, cb) => {
        if (typeof localStorage !== 'undefined') {
          Object.entries(items).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
        }
        if (cb) cb();
      }
    };
  }

  const CalorieKeys = {
    async getCredentials() {
      return new Promise(resolve => getLocalArea().get([KEYS_STORAGE_KEY], r => {
        resolve(Object.assign({ nutritionixAppId: '', nutritionixApiKey: '', usdaApiKey: '', geminiApiKey: '' }, (r && r[KEYS_STORAGE_KEY]) || {}));
      }));
    },
    async saveCredentials(creds) {
      const clean = {
        nutritionixAppId: ((creds && creds.nutritionixAppId) || '').trim(),
        nutritionixApiKey: ((creds && creds.nutritionixApiKey) || '').trim(),
        usdaApiKey: ((creds && creds.usdaApiKey) || '').trim(),
        geminiApiKey: ((creds && creds.geminiApiKey) || '').trim()
      };
      return new Promise(resolve => getLocalArea().set({ [KEYS_STORAGE_KEY]: clean }, () => resolve(clean)));
    },
    async getProfile() {
      return new Promise(resolve => getLocalArea().get([PROFILE_STORAGE_KEY], r => resolve((r && r[PROFILE_STORAGE_KEY]) || null)));
    },
    async saveProfile(profile) {
      return new Promise(resolve => getLocalArea().set({ [PROFILE_STORAGE_KEY]: profile }, () => resolve(profile)));
    }
  };

  return {
    FOOD_RULES,
    getClarifyingQuestions,
    hasKnownFoodRule,
    extractLeadingQuantity,
    buildFollowupQuery,
    estimateCalories,
    estimateCaloriesWithAI,
    queryNutritionix,
    queryUSDA,
    queryGeminiFoodCheck,
    queryGeminiCalorieLookup,
    queryGeminiArbitrate,
    extractGeminiJson,
    candidatesAgree,
    splitFoodTerms,
    estimateGrams,
    cupGramsFor,
    estimateCalorieBudget,
    ACTIVITY_MULTIPLIERS,
    CalorieKeys,
    isSkip
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CalorieTracker;
}
