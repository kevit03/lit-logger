// Calorie tracker tests: clarifying-question selection, query assembly,
// Nutritionix/USDA fallback chain (network mocked), TDEE/budget math, and
// the under-budget streak semantics added to shared/storage.js.
const assert = require('assert');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

function freshCalorieTracker() {
  const full = path.join(__dirname, '..', 'shared', 'calorie-tracker.js');
  delete require.cache[require.resolve(full)];
  return require(full);
}

function freshStorage() {
  const full = path.join(__dirname, '..', 'shared', 'storage.js');
  delete require.cache[require.resolve(full)];
  return require(full);
}

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

async function run() {
  console.log('--- Running test/calorie.test.js ---');

  // 1. Clarifying questions: known foods get specific follow-ups, plus the
  //    shared "anything else" question; unknown foods get the generic one.
  {
    const CT = freshCalorieTracker();
    const bread = CT.getClarifyingQuestions('slice of bread');
    assert.strictEqual(bread.length, 3, 'bread type + slice count + sides');
    assert.strictEqual(bread[0].key, 'type');
    assert.strictEqual(bread[1].key, 'qty');
    assert.strictEqual(bread[2].key, 'sides');

    const rice = CT.getClarifyingQuestions('some RICE');
    assert.ok(rice.some(q => q.key === 'qty'), 'case-insensitive keyword match');

    const mystery = CT.getClarifyingQuestions('a bowl of glorp');
    assert.strictEqual(mystery.length, 2, 'unmatched food falls back to one generic question + sides');
    assert.strictEqual(mystery[0].key, 'details');
    console.log('[PASS] Clarifying-question selection: known foods, case-insensitivity, generic fallback');
  }

  // 2. Query assembly folds answers into one sentence; "no" for sides is dropped.
  {
    const CT = freshCalorieTracker();
    const q1 = CT.buildFollowupQuery('slice of bread', { type: 'wheat bread', qty: '2 slices', sides: 'butter and jam' });
    assert.strictEqual(q1, '2 slices wheat bread and butter and jam');

    const q2 = CT.buildFollowupQuery('slice of bread', { type: 'white bread', qty: '1 slice', sides: 'no' });
    assert.strictEqual(q2, '1 slice white bread', '"no" sides answer contributes nothing to the query');

    assert.strictEqual(CT.isSkip('no'), true);
    assert.strictEqual(CT.isSkip('  Nothing.  '), true);
    assert.strictEqual(CT.isSkip('butter'), false);

    // Regression: the old generic "details" answer used to be appended
    // AFTER the lead already fell back to originalText, so re-stating the
    // same word (e.g. answering "crab" to "what's the exact kind?" for
    // original text "crab") produced a duplicated "crab crab" query.
    const q3 = CT.buildFollowupQuery('crab', { details: 'crab', sides: 'no' });
    assert.strictEqual(q3, 'crab', 'a details answer that repeats the original text must not be duplicated');
    const q4 = CT.buildFollowupQuery('mystery food', { details: '2 legs of snow crab', sides: 'no' });
    assert.strictEqual(q4, '2 legs of snow crab', 'a more specific details answer replaces the vague original text');
    console.log('[PASS] Query assembly folds clarifying answers into one sentence, skips "no" sides, never duplicates "details"');
  }

  // 3. Nutritionix success path: sums nf_calories, builds a breakdown.
  {
    const CT = freshCalorieTracker();
    const fetchImpl = () => jsonResponse({
      foods: [
        { food_name: 'bread', nf_calories: 138.4, serving_qty: 2, serving_unit: 'slice' },
        { food_name: 'butter', nf_calories: 102, serving_qty: 1, serving_unit: 'tbsp' }
      ]
    });
    const result = await CT.estimateCalories({
      query: '2 slices wheat bread and butter',
      credentials: { nutritionixAppId: 'id', nutritionixApiKey: 'key' },
      fetchImpl
    });
    assert.strictEqual(result.source, 'nutritionix');
    assert.strictEqual(result.calories, 240);
    assert.strictEqual(result.breakdown.length, 2);
    assert.strictEqual(result.approximate, false);
    console.log('[PASS] Nutritionix path sums nf_calories and reports an exact breakdown');
  }

  // 4. Nutritionix configured but errors/no match -> falls back to USDA.
  {
    const CT = freshCalorieTracker();
    let nutritionixCalled = false;
    let usdaCalled = false;
    const fetchImpl = (url) => {
      if (String(url).includes('nutritionix')) {
        nutritionixCalled = true;
        return jsonResponse({}, false);
      }
      usdaCalled = true;
      return jsonResponse({
        foods: [{ description: 'Bread, wheat', foodNutrients: [{ nutrientId: 1008, value: 250 }] }]
      });
    };
    const result = await CT.estimateCalories({
      query: '2 slices wheat bread',
      credentials: { nutritionixAppId: 'id', nutritionixApiKey: 'key', usdaApiKey: 'usda-key' },
      fetchImpl
    });
    assert.strictEqual(nutritionixCalled, true);
    assert.strictEqual(usdaCalled, true);
    assert.strictEqual(result.source, 'usda');
    assert.strictEqual(result.approximate, true);
    // 2 slices -> 60g estimate, 250 kcal/100g -> 150 kcal
    assert.strictEqual(result.calories, 150);
    console.log('[PASS] Nutritionix failure falls back to USDA with a gram-scaled estimate');
  }

  // 4b. Food-aware cup weights: verified against real-world reference values
  //     (gathered via web search against USDA/nutrition-database figures).
  //     A cup is NOT one universal weight -- treating every "cup" as a
  //     liquid's ~240g overestimated a cup of cooked rice by ~53% and cooked
  //     pasta by ~72% versus real-world calorie counts for those exact foods.
  {
    const CT = freshCalorieTracker();
    assert.strictEqual(CT.cupGramsFor('cup cooked white rice'), 158, 'rice is ~158g/cup cooked, not a liquid\'s 240g');
    assert.strictEqual(CT.cupGramsFor('cup spaghetti'), 140, 'cooked pasta is ~140g/cup');
    assert.strictEqual(CT.cupGramsFor('cup whole milk'), 240, 'milk/liquids keep the ~240g/cup default');

    // Real reference: 1 cup cooked white rice = ~204 kcal (USDA density ~130
    // kcal/100g). The old flat 240g/cup estimate would have given 312 kcal --
    // a ~53% overestimate -- for the exact same USDA density value.
    assert.strictEqual(Math.round(130 * CT.estimateGrams('cup cooked white rice') / 100), 205);

    // Real reference: 1 cup cooked spaghetti = ~220 kcal (density ~158
    // kcal/100g). The old flat 240g/cup estimate would have given 379 kcal.
    assert.strictEqual(Math.round(158 * CT.estimateGrams('cup spaghetti') / 100), 221);

    const rice = await CT.estimateCalories({
      query: '1 cup cooked white rice',
      credentials: { usdaApiKey: 'usda-key' },
      fetchImpl: () => jsonResponse({ foods: [{ description: 'Rice, white, cooked', foodNutrients: [{ nutrientId: 1008, value: 130 }] }] })
    });
    assert.strictEqual(rice.source, 'usda');
    assert.ok(Math.abs(rice.calories - 204) <= 10, 'USDA-tier rice estimate (' + rice.calories + ') should land near the real ~204 kcal, not ~312');
    console.log('[PASS] Cup weights are food-aware and match real-world rice/pasta calorie counts, not a flat liquid weight');
  }

  // 4c. Hotfix: direct weight/volume units (g, kg, lb, ml, l) were not
  //     recognized at all -- e.g. "200g chicken" fell through to the
  //     "no unit matched" default, which multiplies the number as a COUNT of
  //     100g items (200 x 100g = 20,000g, a 100x overestimate) instead of
  //     treating 200 as the actual gram amount. Also covers the common
  //     no-space form ("200g", not "200 g"), which a plain \b-boundary regex
  //     cannot split since a digit and letter are both word characters.
  {
    const CT = freshCalorieTracker();
    assert.strictEqual(CT.estimateGrams('200g chicken'), 200, 'grams, no space, must not multiply as a 100g-item count');
    assert.strictEqual(CT.estimateGrams('200 g chicken'), 200, 'grams, spaced');
    assert.strictEqual(CT.estimateGrams('150 grams rice'), 150);
    assert.strictEqual(CT.estimateGrams('2kg rice'), 2000, 'kilograms convert to grams');
    assert.strictEqual(CT.estimateGrams('100ml milk'), 100, 'milliliters approximate 1:1 with grams');
    assert.strictEqual(CT.estimateGrams('1 l milk'), 1000, 'liters convert to grams');
    assert.ok(Math.abs(CT.estimateGrams('0.5 lb chicken') - 226.8) < 0.1, 'pounds convert to grams');

    const result = await CT.estimateCalories({
      query: '200g chicken breast',
      credentials: { usdaApiKey: 'usda-key' },
      fetchImpl: () => jsonResponse({ foods: [{ description: 'Chicken, breast, roasted', foodNutrients: [{ nutrientId: 1008, value: 165 }] }] })
    });
    // 165 kcal/100g x 200g = 330 kcal (not 165 kcal/100g x 20,000g = 33,000 kcal)
    assert.strictEqual(result.calories, 330);
    console.log('[PASS] Hotfix: direct weight/volume units (g/kg/lb/ml/l), spaced or not, convert correctly instead of as an item count');
  }

  // 5. Neither provider configured -> manual entry requested, no fetch call made.
  {
    const CT = freshCalorieTracker();
    let called = false;
    const fetchImpl = () => { called = true; return jsonResponse({}); };
    const result = await CT.estimateCalories({ query: 'mystery food', credentials: {}, fetchImpl });
    assert.strictEqual(result.calories, null);
    assert.strictEqual(result.source, 'manual');
    assert.strictEqual(called, false, 'no network call without any configured key');
    console.log('[PASS] No configured provider falls back to manual entry without calling fetch');
  }

  // 5b. AI (Gemini) classify/estimate path: food -> calories, non-food -> null
  //     with a reason, no key -> "unavailable" without calling fetch.
  {
    const CT = freshCalorieTracker();
    assert.strictEqual(CT.hasKnownFoodRule('slice of bread'), true);
    assert.strictEqual(CT.hasKnownFoodRule('a bowl of glorp'), false);

    const foodResult = await CT.estimateCaloriesWithAI({
      text: 'a bowl of glorp',
      credentials: { geminiApiKey: 'key' },
      fetchImpl: () => jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"isFood": true, "calories": 310, "summary": "assumed a typical bowl"}' }] } }]
      })
    });
    assert.strictEqual(foodResult.isFood, true);
    assert.strictEqual(foodResult.calories, 310);
    assert.strictEqual(foodResult.source, 'ai');

    const notFoodResult = await CT.estimateCaloriesWithAI({
      text: 'my homework',
      credentials: { geminiApiKey: 'key' },
      fetchImpl: () => jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"isFood": false, "calories": null, "summary": "not edible"}' }] } }]
      })
    });
    assert.strictEqual(notFoodResult.isFood, false);
    assert.strictEqual(notFoodResult.calories, null);
    assert.strictEqual(notFoodResult.reason, 'not-food');

    let called = false;
    const noKeyResult = await CT.estimateCaloriesWithAI({
      text: 'anything',
      credentials: {},
      fetchImpl: () => { called = true; return jsonResponse({}); }
    });
    assert.strictEqual(noKeyResult.isFood, null);
    assert.strictEqual(called, false, 'no network call without a configured Gemini key');
    console.log('[PASS] AI classify/estimate: known-food detection, food vs. non-food, no-key short circuit');
  }

  // 5c. Fallback robustness: without generationConfig.responseMimeType (left
  //     off since it isn't reliably compatible with the search tool), an
  //     offbeat/"random" input is more likely to make the model wrap its
  //     JSON in a sentence or a markdown fence instead of returning it bare.
  //     A plain JSON.parse on the whole response used to break on exactly
  //     that and silently fall back to manual entry. extractGeminiJson must
  //     recover the embedded object either way.
  {
    const CT = freshCalorieTracker();
    assert.deepStrictEqual(
      CT.extractGeminiJson('Sure, here you go: {"isFood": false, "calories": null, "summary": "not edible"} Hope that helps!'),
      { isFood: false, calories: null, summary: 'not edible' },
      'JSON wrapped in a sentence must still be recovered'
    );
    assert.deepStrictEqual(
      CT.extractGeminiJson('```json\n{"calories": 120, "summary": "typical serving"}\n```'),
      { calories: 120, summary: 'typical serving' },
      'JSON wrapped in a markdown fence must still be recovered'
    );
    assert.strictEqual(CT.extractGeminiJson('I cannot help with that request.'), null, 'genuinely non-JSON text returns null, not a throw');
    assert.strictEqual(CT.extractGeminiJson(''), null);
    assert.strictEqual(CT.extractGeminiJson(null), null);

    // End-to-end: a "random" input where Gemini answers in prose-wrapped
    // JSON must still resolve to a usable result, not fall through to the
    // manual-entry dead end.
    const messyResult = await CT.estimateCaloriesWithAI({
      text: 'purple monkey dishwasher',
      credentials: { geminiApiKey: 'key' },
      fetchImpl: () => jsonResponse({
        candidates: [{ content: { parts: [{ text: 'Here is my answer: {"isFood": false, "calories": null, "summary": "not a food or drink"} let me know if you need more!' }] } }]
      })
    });
    assert.strictEqual(messyResult.isFood, false);
    assert.strictEqual(messyResult.reason, 'not-food');
    console.log('[PASS] Prose-wrapped or fenced JSON from the AI is still parsed instead of falling through to a dead-end fallback');
  }

  // 5c. Leading quantity is parsed off, priced per unit, then multiplied
  //     locally -- e.g. "3 whole grain" -> 3 x (per-unit calories from Gemini).
  {
    const CT = freshCalorieTracker();
    assert.deepStrictEqual(CT.extractLeadingQuantity('3 whole grain'), { qty: 3, rest: 'whole grain' });
    assert.deepStrictEqual(CT.extractLeadingQuantity('whole grain'), { qty: 1, rest: 'whole grain' });
    assert.deepStrictEqual(CT.extractLeadingQuantity('2.5 cups oats'), { qty: 2.5, rest: 'cups oats' });

    let sentPrompt = '';
    const result = await CT.estimateCaloriesWithAI({
      text: '3 whole grain',
      credentials: { geminiApiKey: 'key' },
      fetchImpl: (url, opts) => {
        sentPrompt = JSON.parse(opts.body).contents[0].parts[0].text;
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"isFood": true, "calories": 80, "summary": "1 slice whole grain bread"}' }] } }]
        });
      }
    });
    assert.strictEqual(result.calories, 240, 'per-unit calories (80) x quantity (3)');
    assert.ok(sentPrompt.includes('whole grain') && !sentPrompt.includes('"3 whole grain"'), 'quantity is stripped before asking the AI to price one unit');
    console.log('[PASS] Leading quantity ("3 whole grain") is priced per unit and multiplied locally');
  }

  // 5d. estimateCalories falls back to AI-with-search once Nutritionix and
  //     USDA both fail to match, instead of giving up at "manual".
  {
    const CT = freshCalorieTracker();
    let usdaCalled = false;
    let geminiCalled = false;
    const fetchImpl = (url) => {
      if (String(url).includes('usda')) { usdaCalled = true; return jsonResponse({ foods: [] }); }
      geminiCalled = true;
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"calories": 420, "summary": "found via web search"}' }] } }]
      });
    };
    const result = await CT.estimateCalories({
      query: 'some obscure regional dish',
      credentials: { usdaApiKey: 'usda-key', geminiApiKey: 'gemini-key' },
      fetchImpl
    });
    assert.strictEqual(usdaCalled, true);
    assert.strictEqual(geminiCalled, true);
    assert.strictEqual(result.source, 'ai-search');
    assert.strictEqual(result.calories, 420);
    assert.strictEqual(result.approximate, true);
    console.log('[PASS] estimateCalories falls back to Gemini web search after Nutritionix/USDA both miss');
  }

  // 5e. Cross-checking: every configured source is queried (so they can all
  //     fact-check each other), but when two of them roughly agree, their
  //     average wins even if a third (here, the AI lookup) is an outlier.
  {
    const CT = freshCalorieTracker();
    let geminiCalled = false;
    const fetchImpl = (url) => {
      if (String(url).includes('nutritionix')) return jsonResponse({ foods: [{ food_name: 'chicken breast', nf_calories: 150 }] });
      if (String(url).includes('usda')) return jsonResponse({ foods: [{ description: 'Chicken, breast', foodNutrients: [{ nutrientId: 1008, value: 145 }] }] });
      geminiCalled = true;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"calories": 999, "summary": "should not be used"}' }] } }] });
    };
    const result = await CT.estimateCalories({
      query: 'chicken breast',
      credentials: { nutritionixAppId: 'id', nutritionixApiKey: 'key', usdaApiKey: 'usda-key', geminiApiKey: 'gemini-key' },
      fetchImpl
    });
    assert.strictEqual(geminiCalled, true, 'all configured sources are queried so they can be fact-checked against each other');
    assert.strictEqual(result.source, 'cross-checked');
    assert.strictEqual(result.calories, 148, 'averages the two agreeing candidates (150 and 145), ignoring the 999 outlier');
    console.log('[PASS] Agreeing sources are cross-checked and averaged, ignoring a disagreeing outlier');
  }

  // 5f. Cross-checking catches a bad match (the reported bug: USDA matching
  //     "egg" to "Egg white, raw" at ~52 kcal/100g instead of a whole egg,
  //     which is ~26 kcal for a 50g "egg" gram-estimate vs. Nutritionix's
  //     correct ~78). With none of the three configured sources agreeing,
  //     Gemini arbitrates using the raw numbers and corrects it.
  {
    const CT = freshCalorieTracker();
    const fetchImpl = (url, opts) => {
      if (String(url).includes('nutritionix')) return jsonResponse({ foods: [{ food_name: 'egg', nf_calories: 78 }] });
      if (String(url).includes('usda')) return jsonResponse({ foods: [{ description: 'Egg white, raw', foodNutrients: [{ nutrientId: 1008, value: 52 }] }] });
      // Gemini is hit twice here: once as a third candidate lookup, once to
      // arbitrate. Distinguish them by the arbitration prompt's own wording.
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      if (prompt.includes('disagreed with each other')) {
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"calories": 78, "summary": "trusted Nutritionix; USDA matched egg white, not a whole egg"}' }] } }]
        });
      }
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"calories": 200, "summary": "rough AI guess"}' }] } }] });
    };
    const result = await CT.estimateCalories({
      query: 'egg',
      credentials: { nutritionixAppId: 'id', nutritionixApiKey: 'key', usdaApiKey: 'usda-key', geminiApiKey: 'gemini-key' },
      fetchImpl
    });
    assert.strictEqual(result.source, 'ai-arbitrated');
    assert.strictEqual(result.calories, 78, 'Gemini arbitration corrects the bad USDA egg-white match');
    assert.ok(Array.isArray(result.checkedAgainst) && result.checkedAgainst.length === 3, 'all three candidates (78, 26, 200) are recorded even though none agreed');
    console.log('[PASS] Three disagreeing sources (egg vs. egg white vs. a rough AI guess) are sent to Gemini for arbitration, which corrects it');
  }

  // 5g. Same disagreement, but no Gemini key configured: falls back to the
  //     more reliable source (Nutritionix) by priority instead of an AI tiebreak.
  {
    const CT = freshCalorieTracker();
    const fetchImpl = (url) => {
      if (String(url).includes('nutritionix')) return jsonResponse({ foods: [{ food_name: 'egg', nf_calories: 78 }] });
      return jsonResponse({ foods: [{ description: 'Egg white, raw', foodNutrients: [{ nutrientId: 1008, value: 52 }] }] });
    };
    const result = await CT.estimateCalories({
      query: 'egg',
      credentials: { nutritionixAppId: 'id', nutritionixApiKey: 'key', usdaApiKey: 'usda-key' },
      fetchImpl
    });
    assert.strictEqual(result.source, 'nutritionix', 'without AI to arbitrate, Nutritionix is trusted over a coarse USDA keyword match');
    assert.strictEqual(result.calories, 78);
    console.log('[PASS] Without a Gemini key, disagreement falls back to the higher-priority source');
  }

  // 6. TDEE / budget estimate: known reference values (Mifflin-St Jeor).
  {
    const CT = freshCalorieTracker();
    const weightLb = 154;
    const heightIn = 68;
    const w = weightLb * 0.45359237;
    const h = heightIn * 2.54;
    const expectedBmr = 10 * w + 6.25 * h - 5 * 30 + 5;
    const expectedTdee = expectedBmr * 1.2;
    const result = CT.estimateCalorieBudget({
      weightLb,
      heightIn,
      age: 30,
      sex: 'male',
      activityLevel: 'sedentary',
      deficit: 500
    });
    assert.strictEqual(result.bmr, Math.round(expectedBmr));
    assert.strictEqual(result.tdee, Math.round(expectedTdee));
    assert.strictEqual(result.suggestedBudget, Math.round(expectedTdee - 500));

    const invalid = CT.estimateCalorieBudget({ weightLb: 0, heightIn: 70, age: 30 });
    assert.strictEqual(invalid, null, 'zero/invalid inputs are rejected rather than producing a bogus budget');

    const floor = CT.estimateCalorieBudget({ weightLb: 90, heightIn: 60, age: 25, sex: 'female', activityLevel: 'sedentary', deficit: 5000 });
    assert.strictEqual(floor.suggestedBudget, 1200, 'budget never suggested below the 1200 kcal safety floor');
    console.log('[PASS] TDEE/budget math matches Mifflin-St Jeor and enforces a safety floor');
  }

  // 7. Under-budget streak semantics in shared/storage.js: a day with no
  //    logged entry does NOT count toward the streak, and the boundary is
  //    inclusive (exactly the budget counts as met).
  {
    const TrackerStorage = freshStorage();
    const today = TrackerStorage.getLocalDateStr();
    const y1 = TrackerStorage.addDays(today, -1);
    const y2 = TrackerStorage.addDays(today, -2);
    const y3 = TrackerStorage.addDays(today, -3);

    const dailyMap = {
      [today]: { calories: 1800 },
      [y1]: { calories: 2000 }, // exactly at budget: inclusive boundary
      [y2]: {}                  // no calories entry logged that day
      // y3 has no entry at all
    };
    assert.strictEqual(TrackerStorage.goalMetOn(dailyMap, today, 'calories', 2000, true), true);
    assert.strictEqual(TrackerStorage.goalMetOn(dailyMap, y1, 'calories', 2000, true), true, 'exactly at budget counts as under');
    assert.strictEqual(TrackerStorage.goalMetOn(dailyMap, y2, 'calories', 2000, true), false, 'a day with nothing logged is not "under budget"');

    const streak = TrackerStorage.computeCurrentStreak(dailyMap, 'calories', 2000, today, true);
    assert.strictEqual(streak, 2, 'streak breaks at the day with no logged entry');

    // Regular (non-budget) semantics stay untouched: >= goal, absence == 0.
    const jobsMap = { [today]: { jobs: 5 }, [y1]: { jobs: 3 } };
    assert.strictEqual(TrackerStorage.goalMetOn(jobsMap, today, 'jobs', 5), true);
    assert.strictEqual(TrackerStorage.goalMetOn(jobsMap, y1, 'jobs', 5), false);
    console.log('[PASS] Under-budget streak: inclusive boundary, un-logged days break the streak, non-budget metrics unaffected');
  }

  // 8. ensureCalorieMetric is idempotent and the metric is undeletable once created.
  {
    installMockChrome();
    const TrackerStorage = freshStorage();
    const before = await TrackerStorage.getMetrics();
    assert.strictEqual(before.some(m => m.id === 'calories'), false, 'calories is not seeded by default');

    const first = await TrackerStorage.ensureCalorieMetric();
    const second = await TrackerStorage.ensureCalorieMetric();
    assert.strictEqual(first.id, 'calories');
    assert.strictEqual(second.id, 'calories');

    const after = await TrackerStorage.getMetrics();
    assert.strictEqual(after.filter(m => m.id === 'calories').length, 1, 'calling ensureCalorieMetric twice does not duplicate it');

    const deleted = await TrackerStorage.deleteMetric('calories');
    assert.strictEqual(deleted, false, 'the calorie tracker cannot be deleted like other built-ins');
    uninstallMockChrome();
    console.log('[PASS] ensureCalorieMetric is idempotent and creates an undeletable built-in tracker');
  }

  // 9. Backdated calorie logging: addLog's existing `date` override (already
  //    used by other trackers) works the same way for 'calories', and
  //    getStats().dailyMap -- what the calorie chat's date picker reads --
  //    reflects it on the right day, leaving today's total untouched.
  {
    installMockChrome();
    const TrackerStorage = freshStorage();
    await TrackerStorage.ensureCalorieMetric();
    const today = TrackerStorage.getLocalDateStr();
    const yesterday = TrackerStorage.addDays(today, -1);

    await TrackerStorage.addLog({ metricId: 'calories', count: 450, notes: 'leftover pizza', date: yesterday });
    await TrackerStorage.addLog({ metricId: 'calories', count: 300, notes: 'oatmeal', date: today });

    const stats = await TrackerStorage.getStats();
    assert.strictEqual(stats.today.calories, 300, "today's total only includes today's entry");
    assert.strictEqual(stats.dailyMap[yesterday].calories, 450, "yesterday's backdated entry lands on yesterday, not today");

    const yesterdaysLogs = await TrackerStorage.getLogs({ metricId: 'calories', startDate: yesterday, endDate: yesterday });
    assert.strictEqual(yesterdaysLogs.length, 1);
    assert.strictEqual(yesterdaysLogs[0].notes, 'leftover pizza');
    uninstallMockChrome();
    console.log('[PASS] Calorie entries can be backdated via addLog\'s date param, and dailyMap/getLogs reflect the right day');
  }

  console.log('--- test/calorie.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
