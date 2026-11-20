import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hash32 } from '@/lib/i18n/hash';
import { getBaseLocale, getProjectLocales, localeCompletion, normalizeLocalization } from '@/lib/i18n/localization';
import { projectArtboards } from '@/lib/i18n/project';
import type { ArtboardState, TextElementProps } from '@/types/artboard';

function template(slug: string): ArtboardState[] {
  return JSON.parse(readFileSync(`public/data/projects/${slug}.json`, 'utf8')).projectData;
}

const texts = (boards: ArtboardState[]) => boards.flatMap((board) =>
  board.elements.filter((element): element is TextElementProps => element.type === 'text')
);

for (const slug of ['taiga-md3', 'taiga-glass']) {
  test(`${slug} opens in Japanese and projects a complete English screenshot set`, () => {
    const original = template(slug);
    const boards = normalizeLocalization(original);
    const before = JSON.stringify(boards);
    assert.deepEqual(boards.map((board) => board.name), ['Hero', 'Point 01', 'Point 02', 'Point 03', 'Point 04']);
    assert.equal(getBaseLocale(boards), 'ja');
    assert.deepEqual(getProjectLocales(boards).map((locale) => locale.code), ['en-US']);
    assert.equal(texts(boards).length, 15);
    assert.deepEqual(localeCompletion(boards, 'en-US'), { translated: 15, total: 15 });
    assert.strictEqual(projectArtboards(boards, 'ja'), boards);
    assert.equal(texts(boards)[0].content, 'あなたの毎日に、');
    assert.equal(texts(boards)[1].content, 'ちょうどいいアプリ');

    for (const board of boards) {
      assert.equal(board.localization?.baseLocale, 'ja');
      for (const element of texts([board])) {
        const override = board.localized?.['en-US']?.[element.id];
        assert.ok(override, `${element.id} needs an English override`);
        assert.ok(override.content?.trim(), `${element.id} needs English copy`);
        assert.equal(override.sourceHash, hash32(element.content));
      }
    }

    const english = projectArtboards(boards, 'en-US');
    assert.deepEqual(english.map((board) => board.id), boards.map((board) => board.id));
    for (const board of english) {
      for (const element of texts([board])) {
        assert.equal(element.content, board.localized?.['en-US']?.[element.id]?.content);
        assert.doesNotMatch(element.content, /[\u3040-\u30ff\u3400-\u9fff]/);
      }
    }
    assert.equal(texts(english)[0].content, 'For your day,');
    assert.equal(texts(english)[1].content, 'An app that fits');
    assert.equal(JSON.stringify(boards), before);
  });
}

test('both Taiga styles keep the same Japanese and English story', () => {
  const md3 = template('taiga-md3');
  const glass = template('taiga-glass');
  for (const locale of ['ja', 'en-US']) {
    assert.deepEqual(
      texts(projectArtboards(md3, locale)).map((element) => element.content),
      texts(projectArtboards(glass, locale)).map((element) => element.content)
    );
  }
});
