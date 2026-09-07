# Attribution and data provenance

## Initial link candidates

- Project: Rhilip/BangumiExtLinker
- Source: https://github.com/Rhilip/BangumiExtLinker
- Pinned revision: `8f853e6bf9d6cb382448091ce3afaf2d9cdb0a3f`
- License: Creative Commons Attribution 4.0 International (see LICENSE-DATA).
- Changes: retained Bangumi IDs and TMDB/AniDB/IMDb/TheTVDB/Wikidata identifiers;
  parsed TMDB paths into typed targets; removed unrelated fields; sorted and
  deduplicated candidates; conflicting records are excluded with an import report.
- `sources/seed.json` includes the source commit and SHA-256 of the original input.
  Existing TMDB links are imported into `data/`, preserving the supplied scope.

## AniDB cross-check

- Official AniDB title dump: https://anidb.net/api/anime-titles.xml.gz
- AniDB-to-TMDB correspondences: https://github.com/Anime-Lists/anime-lists
- `sources/anidb-check.json` records the source revision, input checksums and
  comparison results. Only identifier relationships and comparison statuses are
  retained; AniDB title text is read at runtime.

## Bangumi

Archive: https://github.com/bangumi/Archive

Bangumi contributors retain copyright in their contributions under the license
linked from https://bgm.tv/about/copyright (CC BY-SA). `test/fixtures/mushoku.json`
is a reduced factual sample of names, IDs, dates and episode numbering from the
Archive snapshot identified in that file, and retains that source license.
Subject summaries and infobox text were omitted from the redistributed fixture.
This exception is not relicensed under MIT or CC BY 4.0.

Runtime copies of full Archive/TMDB metadata stay in ignored local caches. The
mapping dataset grants rights only in this project's mapping contributions,
not in underlying third-party works, artwork or source descriptions.

## TMDB

https://www.themoviedb.org/

This product uses the TMDB API but is not endorsed or certified by TMDB.
TMDB metadata and images remain subject to their original terms. This repository
publishes identifiers and correspondence, not artwork or a metadata mirror.
