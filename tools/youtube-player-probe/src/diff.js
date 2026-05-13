'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readReport(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function collectPageSummary(report) {
  const adLikePaths = new Set();
  const highValueAdPaths = new Set();
  const knownStripperPathsPresent = new Set();
  const domSignals = new Set();
  const visibleAdSignals = new Set();
  const visibleLoadingSignals = new Set();
  const endpointCounts = new Map();
  const timings = [];
  const mediaSummaries = [];

  for (const page of report.pages || []) {
    if (page.timing) timings.push(page.timing);
    if (page.summary) mediaSummaries.push(page.summary);
    for (const signal of page.timing?.domSignals || []) domSignals.add(signal);
    for (const signal of page.timing?.visibleAdSignals || []) visibleAdSignals.add(signal);
    for (const signal of page.timing?.visibleLoadingSignals || []) visibleLoadingSignals.add(signal);
    for (const source of getSources(page)) {
      endpointCounts.set(source.name, (endpointCounts.get(source.name) || 0) + 1);
      for (const item of source.adLikePaths || []) {
        const labeled = `${source.name}:${item}`;
        adLikePaths.add(labeled);
        if (isHighValueAdPath(item)) highValueAdPaths.add(labeled);
      }
      for (const item of source.knownStripperPathsPresent || []) {
        knownStripperPathsPresent.add(`${source.name}:${item}`);
      }
    }
  }

  return {
    adLikePaths,
    highValueAdPaths,
    knownStripperPathsPresent,
    domSignals,
    visibleAdSignals,
    visibleLoadingSignals,
    endpointCounts,
    timings,
    mediaSummaries
  };
}

function getSources(page) {
  const sources = [];
  for (const entry of page.network || []) {
    sources.push({
      name: `network:${entry.endpoint}`,
      adLikePaths: entry.adLikePaths || [],
      knownStripperPathsPresent: entry.knownStripperPathsPresent || []
    });
  }
  for (const [name, entry] of Object.entries(page.initialPayloads || {})) {
    sources.push({
      name: `initial:${name}`,
      adLikePaths: entry.adLikePaths || [],
      knownStripperPathsPresent: entry.knownStripperPathsPresent || []
    });
  }
  return sources;
}

function isHighValueAdPath(pathValue) {
  if (/tooltipData\.tooltipViewModel\.placement/i.test(pathValue)) return false;
  return /(adPlacements|adSlots|playerAds|adBreak|adSlot|adPlacement|inPlayerAdLayoutRenderer|playerBytesAdLayoutRenderer|clientForecastingAdRenderer|adBreakServiceRenderer|daiConfig|showInstream|skipAdViewModel|adDurationRemaining|adBadge|serializedAdServingDataEntry)/i.test(pathValue);
}

function difference(next, base) {
  return [...next].filter((item) => !base.has(item)).sort();
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function formatList(title, items, marker = '+') {
  if (!items.length) return [`${title}: none`];
  return [
    `${title}:`,
    ...items.map((item) => `${marker} ${item}`)
  ];
}

function runDiff(basePath, nextPath) {
  const base = collectPageSummary(readReport(basePath));
  const next = collectPageSummary(readReport(nextPath));

  const newAdLike = difference(next.adLikePaths, base.adLikePaths);
  const missingAdLike = difference(base.adLikePaths, next.adLikePaths);
  const newHighValue = difference(next.highValueAdPaths, base.highValueAdPaths);
  const missingHighValue = difference(base.highValueAdPaths, next.highValueAdPaths);
  const newKnown = difference(next.knownStripperPathsPresent, base.knownStripperPathsPresent);
  const missingKnown = difference(base.knownStripperPathsPresent, next.knownStripperPathsPresent);
  const newSignals = difference(next.domSignals, base.domSignals);
  const missingSignals = difference(base.domSignals, next.domSignals);
  const newVisibleAdSignals = difference(next.visibleAdSignals, base.visibleAdSignals);
  const missingVisibleAdSignals = difference(base.visibleAdSignals, next.visibleAdSignals);
  const newLoadingSignals = difference(next.visibleLoadingSignals, base.visibleLoadingSignals);
  const missingLoadingSignals = difference(base.visibleLoadingSignals, next.visibleLoadingSignals);

  const baseFirstPlaying = average(base.timings.map((timing) => timing.navigationToFirstPlayingMs));
  const nextFirstPlaying = average(next.timings.map((timing) => timing.navigationToFirstPlayingMs));
  const baseFirstContentPlaying = average(base.timings.map((timing) => timing.navigationToFirstContentPlayingMs));
  const nextFirstContentPlaying = average(next.timings.map((timing) => timing.navigationToFirstContentPlayingMs));
  const baseFirstCurrentSrc = average(base.timings.map((timing) => timing.navigationToFirstCurrentSrcMs));
  const nextFirstCurrentSrc = average(next.timings.map((timing) => timing.navigationToFirstCurrentSrcMs));
  const baseFirstPlayableState = average(base.timings.map((timing) => timing.navigationToFirstPlayableStateMs));
  const nextFirstPlayableState = average(next.timings.map((timing) => timing.navigationToFirstPlayableStateMs));
  const baseFirstProgress = average(base.timings.map((timing) => timing.navigationToFirstVideoProgressMs));
  const nextFirstProgress = average(next.timings.map((timing) => timing.navigationToFirstVideoProgressMs));
  const baseFirstMediaRequest = average(base.mediaSummaries.map((summary) => summary.firstMediaRequestMs));
  const nextFirstMediaRequest = average(next.mediaSummaries.map((summary) => summary.firstMediaRequestMs));
  const baseFirstMediaResponse = average(base.mediaSummaries.map((summary) => summary.firstMediaResponseMs));
  const nextFirstMediaResponse = average(next.mediaSummaries.map((summary) => summary.firstMediaResponseMs));
  const baseVisibleLoading = average(base.timings.map((timing) => timing.visibleLoadingEvents));
  const nextVisibleLoading = average(next.timings.map((timing) => timing.visibleLoadingEvents));

  const lines = [
    `Base: ${basePath}`,
    `Next: ${nextPath}`,
    '',
    ...formatList('New high-value ad paths', newHighValue),
    '',
    ...formatList('Missing high-value ad paths', missingHighValue, '-'),
    '',
    ...formatList('New ad-like paths', newAdLike),
    '',
    ...formatList('Missing ad-like paths', missingAdLike, '-'),
    '',
    ...formatList('New known stripper paths', newKnown),
    '',
    ...formatList('Missing known stripper paths', missingKnown, '-'),
    '',
    ...formatList('New DOM ad signals', newSignals),
    '',
    ...formatList('Missing DOM ad signals', missingSignals, '-'),
    '',
    ...formatList('New visible DOM ad signals', newVisibleAdSignals),
    '',
    ...formatList('Missing visible DOM ad signals', missingVisibleAdSignals, '-'),
    '',
    ...formatList('New visible loading signals', newLoadingSignals),
    '',
    ...formatList('Missing visible loading signals', missingLoadingSignals, '-'),
    '',
    'Timing:',
    `navigationToFirstPlayingMs average: ${baseFirstPlaying ?? 'n/a'} -> ${nextFirstPlaying ?? 'n/a'}`,
    `navigationToFirstContentPlayingMs average: ${baseFirstContentPlaying ?? 'n/a'} -> ${nextFirstContentPlaying ?? 'n/a'}`,
    `navigationToFirstCurrentSrcMs average: ${baseFirstCurrentSrc ?? 'n/a'} -> ${nextFirstCurrentSrc ?? 'n/a'}`,
    `firstMediaRequestMs average: ${baseFirstMediaRequest ?? 'n/a'} -> ${nextFirstMediaRequest ?? 'n/a'}`,
    `firstMediaResponseMs average: ${baseFirstMediaResponse ?? 'n/a'} -> ${nextFirstMediaResponse ?? 'n/a'}`,
    `navigationToFirstPlayableStateMs average: ${baseFirstPlayableState ?? 'n/a'} -> ${nextFirstPlayableState ?? 'n/a'}`,
    `navigationToFirstVideoProgressMs average: ${baseFirstProgress ?? 'n/a'} -> ${nextFirstProgress ?? 'n/a'}`,
    `visibleLoadingEvents average: ${baseVisibleLoading ?? 'n/a'} -> ${nextVisibleLoading ?? 'n/a'}`
  ];

  return lines.join('\n');
}

module.exports = {
  runDiff,
  collectPageSummary
};
