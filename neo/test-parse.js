const assert = require('assert');
const { parseSections, parseDetail } = require('./parse');
const th = (u) => ({ musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: u }] } } });
const home = { contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
  { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: 'Mixes' }] } } }, contents: [
    { musicTwoRowItemRenderer: { title: { runs: [{ text: 'Mix 1' }] }, subtitle: { runs: [{ text: 'Playlist' }, { text: ' • ' }, { text: 'YT' }] },
      thumbnailRenderer: th('https://lh3.googleusercontent.com/abc=w226-h226-l90-rj'),
      navigationEndpoint: { browseEndpoint: { browseId: 'VLRDCLAK1', browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_PLAYLIST' } } } },
      thumbnailOverlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchPlaylistEndpoint: { playlistId: 'RDCLAK1' } } } } } } } },
    { musicResponsiveListItemRenderer: { flexColumns: [ { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Chanson A' }] } } }, { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Artiste X' }] } } } ],
      playlistItemData: { videoId: 'abcdefghijk' }, thumbnail: th('https://x/y=w60-h60-l90-rj') } } ] } } ] } } } }] } } };
const s = parseSections(home);
assert.equal(s.length, 1); assert.equal(s[0].title, 'Mixes');
assert.equal(s[0].items[0].kind, 'playlist'); assert.equal(s[0].items[0].play.playlistId, 'RDCLAK1');
assert.ok(s[0].items[0].thumb.includes('w400-h400'));
assert.equal(s[0].items[1].kind, 'song'); assert.equal(s[0].items[1].play.videoId, 'abcdefghijk');
const search = { contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
  { musicShelfRenderer: { title: { runs: [{ text: 'Albums' }] }, contents: [ { musicResponsiveListItemRenderer: { flexColumns: [
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Mon album' }] } } },
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Album' }, { text: ' • ' }, { text: 'Moi' }] } } } ],
    navigationEndpoint: { browseEndpoint: { browseId: 'MPREb_1' } } } } ] } } ] } } } }] } } };
const r = parseSections(search);
assert.equal(r[0].items[0].kind, 'album'); assert.equal(r[0].items[0].browseId, 'MPREb_1');
const detail = { header: { musicDetailHeaderRenderer: { title: { runs: [{ text: 'Mon album' }] }, subtitle: { runs: [{ text: 'Album' }] }, thumbnail: th('https://z=w120-h120-l90-rj') } },
  contents: { x: { musicShelfRenderer: { contents: [ { musicResponsiveListItemRenderer: { flexColumns: [ { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Piste 1' }] } } } ], playlistItemData: { videoId: 'vid00000001', playlistId: 'OLAK5uy_zzz' } } } ] } } } };
const d = parseDetail(detail, 'MPREb_1');
assert.equal(d.header.title, 'Mon album'); assert.equal(d.header.playlistId, 'OLAK5uy_zzz');
assert.ok(d.sections[0].items[0].thumb.includes('w600'));
assert.deepEqual(parseSections({}), []); assert.deepEqual(parseSections(null), []);
console.log('parse OK');
