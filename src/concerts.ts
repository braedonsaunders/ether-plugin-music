// Curated flagship video concerts + zero-auth live concert discovery.
// All 82 Deezer artist IDs, IMDb IDs, and high-res 2:3 poster URLs are verified.

import type { HostEnv, KindArtRef, KindItem } from "./types.ts";
import { KVCache, DAY_MS, rethrowHostFault } from "./kv.ts";
import { decadeOfYear, formatDuration, normalizeText, parseReleaseDate } from "./normalize.ts";

export interface CuratedConcert {
  slug: string;
  deezerArtistId: number;
  artistName: string;
  title: string;
  year: number;
  filmedYear: number;
  durationSec: number;
  venue: string;
  genres: string[];
  curation: string[];
  imdbId: string;
  posterUrl: string;
  posterWidth: number;
  posterHeight: number;
  /** Optional concert-specific landscape still (16:9 / widescreen). Never an artist photo. */
  backdropUrl?: string;
  backdropWidth?: number;
  backdropHeight?: number;
  summary: string;
  /** True when the film title is distinctive enough to match indexer releases without repeating the artist name. */
  standaloneTitle?: boolean;
}

export const CURATED_CONCERTS: CuratedConcert[] = [
  {
    "slug": "talking-heads-stop-making-sense",
    "deezerArtistId": 181,
    "artistName": "Talking Heads",
    "title": "Stop Making Sense",
    "year": 1984,
    "filmedYear": 1983,
    "durationSec": 5280,
    "venue": "Pantages Theatre, Hollywood",
    "genres": [
      "Rock",
      "Indie & Alternative"
    ],
    "curation": [
      "Trending",
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0088178",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BOTY2Y2EzMTctYTZiMC00YzEzLWIwMDItODQyYWUyY2U2MTk4XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1921,
    "posterHeight": 2920,
    "summary": "Jonathan Demme's landmark concert film capturing Talking Heads at the Pantages Theatre in Hollywood across three nights in December 1983.",
    "standaloneTitle": true
  },
  {
    "slug": "pink-floyd-pulse",
    "deezerArtistId": 860,
    "artistName": "Pink Floyd",
    "title": "P.U.L.S.E. Live at Earls Court",
    "year": 1995,
    "filmedYear": 1994,
    "durationSec": 8700,
    "venue": "Earls Court, London",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Trending",
      "Classic",
      "Stadium",
      "Iconic"
    ],
    "imdbId": "tt0110758",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTYwNTg1NzIwNF5BMl5BanBnXkFtZTcwNTkxNjczMQ@@._V1_.jpg",
    "posterWidth": 369,
    "posterHeight": 500,
    "summary": "Filmed at Earls Court in London during The Division Bell Tour, featuring a complete live performance of The Dark Side of the Moon."
  },
  {
    "slug": "pink-floyd-live-at-pompeii",
    "deezerArtistId": 860,
    "artistName": "Pink Floyd",
    "title": "Live at Pompeii",
    "year": 1972,
    "filmedYear": 1971,
    "durationSec": 5100,
    "venue": "Pompeii Amphitheatre, Italy",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0069090",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZjUxY2VjOTMtMzQ2YS00NjhjLWI0NWUtZWEyNDQ3NDhkNjljXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1280,
    "posterHeight": 1920,
    "summary": "Pink Floyd perform an atmospheric, audience-free live set inside the ancient Roman amphitheatre in Pompeii."
  },
  {
    "slug": "queen-live-at-wembley",
    "deezerArtistId": 412,
    "artistName": "Queen",
    "title": "Live at Wembley Stadium",
    "year": 1986,
    "filmedYear": 1986,
    "durationSec": 6660,
    "venue": "Wembley Stadium, London",
    "genres": [
      "Rock",
      "Pop"
    ],
    "curation": [
      "Trending",
      "Classic",
      "Stadium",
      "Iconic"
    ],
    "imdbId": "tt0158874",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMjIxY2RkNjktM2U2Zi00NTU5LWI3ZTMtNTc5OTM1ZjI5MzE2XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 554,
    "posterHeight": 800,
    "summary": "Queen's legendary July 1986 Magic Tour stadium show before 72,000 fans at Wembley Stadium."
  },
  {
    "slug": "queen-rock-montreal",
    "deezerArtistId": 412,
    "artistName": "Queen",
    "title": "Queen Rock Montreal",
    "year": 2024,
    "filmedYear": 1981,
    "durationSec": 5700,
    "venue": "Montreal Forum, Canada",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Trending",
      "New & Recent",
      "Classic"
    ],
    "imdbId": "tt30973483",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYWZjMTM3NDktOWNlOS00YmYxLWEzYmYtZjhlOWExYzViNmIzXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1000,
    "posterHeight": 1500,
    "summary": "Digitally remastered in IMAX 4K from original 35mm film, capturing Queen at their peak across two nights at the Montreal Forum in 1981.",
    "standaloneTitle": true
  },
  {
    "slug": "nirvana-mtv-unplugged",
    "deezerArtistId": 415,
    "artistName": "Nirvana",
    "title": "MTV Unplugged in New York",
    "year": 1994,
    "filmedYear": 1993,
    "durationSec": 3960,
    "venue": "Sony Music Studios, New York",
    "genres": [
      "Rock",
      "Indie & Alternative"
    ],
    "curation": [
      "Trending",
      "Classic",
      "Unplugged",
      "Iconic"
    ],
    "imdbId": "tt36980185",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BM2VhYzIxODItMzdmMC00MWU1LWE5ZDYtZTIwYzgyNjk2MTdmXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 990,
    "posterHeight": 1400,
    "summary": "Nirvana's haunting, stripped-back acoustic performance filmed at Sony Music Studios in November 1993."
  },
  {
    "slug": "nirvana-live-at-reading",
    "deezerArtistId": 415,
    "artistName": "Nirvana",
    "title": "Live at Reading",
    "year": 2009,
    "filmedYear": 1992,
    "durationSec": 5820,
    "venue": "Reading Festival, England",
    "genres": [
      "Rock",
      "Indie & Alternative"
    ],
    "curation": [
      "Classic",
      "Festivals"
    ],
    "imdbId": "tt3189338",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTUxNTYxMjcxMl5BMl5BanBnXkFtZTgwNTIzNzQ4MzE@._V1_.jpg",
    "posterWidth": 333,
    "posterHeight": 500,
    "summary": "Nirvana's triumphant headline set closing the 1992 Reading Festival."
  },
  {
    "slug": "led-zeppelin-song-remains-the-same",
    "deezerArtistId": 848,
    "artistName": "Led Zeppelin",
    "title": "The Song Remains the Same",
    "year": 1976,
    "filmedYear": 1973,
    "durationSec": 8220,
    "venue": "Madison Square Garden, New York",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0075244",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYTM4MjBmZGYtMDlmZS00MmQ3LWJhZTItMTE4MWU0ZjIzOTJjXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1488,
    "posterHeight": 2204,
    "summary": "Filmed across three sold-out nights at Madison Square Garden in July 1973 at the height of Led Zeppelin's stadium reign.",
    "standaloneTitle": true
  },
  {
    "slug": "led-zeppelin-celebration-day",
    "deezerArtistId": 848,
    "artistName": "Led Zeppelin",
    "title": "Celebration Day",
    "year": 2012,
    "filmedYear": 2007,
    "durationSec": 7440,
    "venue": "The O2 Arena, London",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic",
      "Stadium"
    ],
    "imdbId": "tt2414166",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BM2I4MjM1NTgtYjJlNS00MWIwLTlmY2QtYzEyOGQwM2JlYmY3XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1067,
    "posterHeight": 1600,
    "summary": "Led Zeppelin's historic 2007 tribute reunion concert at London's O2 Arena with Jason Bonham on drums."
  },
  {
    "slug": "acdc-live-at-river-plate",
    "deezerArtistId": 115,
    "artistName": "AC/DC",
    "title": "Live at River Plate",
    "year": 2011,
    "filmedYear": 2009,
    "durationSec": 6600,
    "venue": "Estadio Monumental, Buenos Aires",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Trending",
      "Stadium"
    ],
    "imdbId": "tt1933535",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYzk2YWUyYWQtMWNjMC00MmVmLTk4NTktYzY0NDUzNDIzOWRlXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1998,
    "posterHeight": 2960,
    "summary": "Captured across three thunderous nights in front of 200,000 fans in Buenos Aires on the Black Ice World Tour."
  },
  {
    "slug": "acdc-live-at-donington",
    "deezerArtistId": 115,
    "artistName": "AC/DC",
    "title": "Live at Donington",
    "year": 1992,
    "filmedYear": 1991,
    "durationSec": 7200,
    "venue": "Donington Park, England",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic",
      "Festivals"
    ],
    "imdbId": "tt0337566",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMmUzNjFhMDMtZDVjZC00MTljLWI2YzMtZmZmYjMwM2Y0MTY2XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 2000,
    "posterHeight": 2963,
    "summary": "AC/DC headline the Monsters of Rock festival at Donington Park before more than 70,000 fans."
  },
  {
    "slug": "radiohead-in-rainbows-basement",
    "deezerArtistId": 399,
    "artistName": "Radiohead",
    "title": "In Rainbows: From the Basement",
    "year": 2008,
    "filmedYear": 2008,
    "durationSec": 3720,
    "venue": "Maida Vale Studios, London",
    "genres": [
      "Rock",
      "Indie & Alternative"
    ],
    "curation": [
      "Trending",
      "Unplugged",
      "Iconic"
    ],
    "imdbId": "tt1454148",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BY2JlOGNjYTAtYWYxYy00ZTQ0LWExMTQtODY4MTBhYzEyNTJjXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1600,
    "posterHeight": 2400,
    "summary": "An intimate, studio-live performance of In Rainbows produced by Nigel Godrich in London."
  },
  {
    "slug": "fleetwood-mac-the-dance",
    "deezerArtistId": 169,
    "artistName": "Fleetwood Mac",
    "title": "The Dance",
    "year": 1997,
    "filmedYear": 1997,
    "durationSec": 6360,
    "venue": "Warner Bros. Studios, Burbank",
    "genres": [
      "Rock",
      "Pop"
    ],
    "curation": [
      "Classic",
      "Unplugged"
    ],
    "imdbId": "tt0123073",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTQ2OTQzOTI3Nl5BMl5BanBnXkFtZTgwNjQ1MzgwMzE@._V1_.jpg",
    "posterWidth": 392,
    "posterHeight": 500,
    "summary": "The classic Rumours lineup reunites for an emotional live performance celebrating the 20th anniversary of Rumours."
  },
  {
    "slug": "david-bowie-ziggy-stardust",
    "deezerArtistId": 997,
    "artistName": "David Bowie",
    "title": "Ziggy Stardust and the Spiders from Mars",
    "year": 1979,
    "filmedYear": 1973,
    "durationSec": 5400,
    "venue": "Hammersmith Odeon, London",
    "genres": [
      "Rock",
      "Pop"
    ],
    "curation": [
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0086643",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BNjlhZGVkY2ItNWE2Yi00ZTBiLWE2MzMtNjZkOTkyMzFkN2UxXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1080,
    "posterHeight": 1600,
    "summary": "D. A. Pennebaker captures David Bowie's final performance as Ziggy Stardust at London's Hammersmith Odeon.",
    "standaloneTitle": true
  },
  {
    "slug": "the-band-the-last-waltz",
    "deezerArtistId": 3509,
    "artistName": "The Band",
    "title": "The Last Waltz",
    "year": 1978,
    "filmedYear": 1976,
    "durationSec": 7020,
    "venue": "Winterland Ballroom, San Francisco",
    "genres": [
      "Rock",
      "Country & Folk"
    ],
    "curation": [
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0077838",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYWE3MjEzNjgtNzE2OC00ZTQwLWFhYjUtNDQ4ZWJhYTFmMzYzXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 656,
    "posterHeight": 1000,
    "summary": "Martin Scorsese's legendary concert film documenting The Band's farewell concert with Bob Dylan, Neil Young, Joni Mitchell, and Muddy Waters.",
    "standaloneTitle": true
  },
  {
    "slug": "the-beatles-eight-days-a-week",
    "deezerArtistId": 1,
    "artistName": "The Beatles",
    "title": "Eight Days a Week: The Touring Years",
    "year": 2016,
    "filmedYear": 1966,
    "durationSec": 6360,
    "venue": "Shea Stadium & World Tour",
    "genres": [
      "Rock",
      "Pop"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt2531318",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTc0NDgwMTk2OV5BMl5BanBnXkFtZTgwNjEzODIyOTE@._V1_.jpg",
    "posterWidth": 1350,
    "posterHeight": 2000,
    "summary": "Ron Howard's portrait of The Beatles' electrifying touring years, culminating in restored live concert footage."
  },
  {
    "slug": "rolling-stones-shine-a-light",
    "deezerArtistId": 11,
    "artistName": "The Rolling Stones",
    "title": "Shine a Light",
    "year": 2008,
    "filmedYear": 2006,
    "durationSec": 7320,
    "venue": "Beacon Theatre, New York",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt0893382",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYTg5ZTY5ZmQtNDA5NC00MTEyLTlmYWUtY2M1MTNiZTY4MmMyXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1957,
    "posterHeight": 2868,
    "summary": "Martin Scorsese films The Rolling Stones in an intimate two-night stand at New York's Beacon Theatre.",
    "standaloneTitle": true
  },
  {
    "slug": "jimi-hendrix-monterey",
    "deezerArtistId": 849,
    "artistName": "Jimi Hendrix",
    "title": "Jimi Plays Monterey",
    "year": 1986,
    "filmedYear": 1967,
    "durationSec": 2940,
    "venue": "Monterey Pop Festival, California",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic",
      "Festivals",
      "Iconic"
    ],
    "imdbId": "tt0093312",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BOTdjZjY3ZjQtOGY2Yi00YmQ5LWIyZGYtYmFjMjhlMzkxYTk4XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 667,
    "posterHeight": 1000,
    "summary": "Jimi Hendrix's incendiary 1967 American breakthrough performance at the Monterey International Pop Festival.",
    "standaloneTitle": true
  },
  {
    "slug": "the-doors-hollywood-bowl",
    "deezerArtistId": 847,
    "artistName": "The Doors",
    "title": "Live at the Hollywood Bowl",
    "year": 1987,
    "filmedYear": 1968,
    "durationSec": 3900,
    "venue": "Hollywood Bowl, Los Angeles",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt0195658",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BNDY2MzA3OWQtZjRhMS00ZmI3LThkMWMtNDgzNGMwOWUzZDhiXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1400,
    "posterHeight": 2100,
    "summary": "The Doors' hypnotic July 5, 1968 concert filmed live at the Hollywood Bowl."
  },
  {
    "slug": "dire-straits-alchemy-live",
    "deezerArtistId": 176,
    "artistName": "Dire Straits",
    "title": "Alchemy Live",
    "year": 1984,
    "filmedYear": 1983,
    "durationSec": 5640,
    "venue": "Hammersmith Odeon, London",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt0310608",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BOTY0Y2I4YTgtMzU3NS00MDVhLThhMWUtYjBjOWNkODMyMGU0XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 597,
    "posterHeight": 600,
    "summary": "Dire Straits close their Love Over Gold tour with an incandescent performance featuring an extended Sultans of Swing."
  },
  {
    "slug": "eagles-hell-freezes-over",
    "deezerArtistId": 210,
    "artistName": "Eagles",
    "title": "Hell Freezes Over",
    "year": 1994,
    "filmedYear": 1994,
    "durationSec": 5940,
    "venue": "Warner Burbank Studios, California",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic",
      "Unplugged"
    ],
    "imdbId": "tt0123815",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTI4MTk3NTE3OV5BMl5BanBnXkFtZTcwMDQ2NjgyMQ@@._V1_.jpg",
    "posterWidth": 355,
    "posterHeight": 500,
    "summary": "The Eagles reunite after fourteen years for a richly arranged live set highlighted by their iconic acoustic Hotel California.",
    "standaloneTitle": true
  },
  {
    "slug": "u2-rattle-and-hum",
    "deezerArtistId": 163,
    "artistName": "U2",
    "title": "Rattle and Hum",
    "year": 1988,
    "filmedYear": 1987,
    "durationSec": 5940,
    "venue": "Joshua Tree Tour, North America",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic",
      "Stadium"
    ],
    "imdbId": "tt0096328",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZTQ3MDI1MjYtMmI0YS00YWFkLTk4ZDEtZDQ5MzdhNmZkZWExXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1516,
    "posterHeight": 2265,
    "summary": "Phil Joanou follows U2 across America on the Joshua Tree Tour with blistering black-and-white and color concert performances.",
    "standaloneTitle": true
  },
  {
    "slug": "bruce-springsteen-on-broadway",
    "deezerArtistId": 4762,
    "artistName": "Bruce Springsteen",
    "title": "Springsteen on Broadway",
    "year": 2018,
    "filmedYear": 2018,
    "durationSec": 9180,
    "venue": "Walter Kerr Theatre, New York",
    "genres": [
      "Rock",
      "Country & Folk"
    ],
    "curation": [
      "Unplugged",
      "Iconic"
    ],
    "imdbId": "tt8716334",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTAyMjY3MjkyNzZeQTJeQWpwZ15BbWU4MDY4MjUzODYz._V1_.jpg",
    "posterWidth": 1382,
    "posterHeight": 2048,
    "summary": "An intimate solo acoustic evening of songs and stories filmed at the Walter Kerr Theatre in New York.",
    "standaloneTitle": true
  },
  {
    "slug": "david-gilmour-live-at-pompeii",
    "deezerArtistId": 5114,
    "artistName": "David Gilmour",
    "title": "Live at Pompeii",
    "year": 2017,
    "filmedYear": 2016,
    "durationSec": 6840,
    "venue": "Pompeii Amphitheatre, Italy",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Trending",
      "Stadium"
    ],
    "imdbId": "tt7359702",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYjVlODQyZTEtYTdhMS00NjgxLWE3NzAtZmQ4NWEwZTI5OTEyXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 716,
    "posterHeight": 1075,
    "summary": "45 years after Pink Floyd's historic film, David Gilmour returns to Pompeii for two spectacular open-air concerts."
  },
  {
    "slug": "roger-waters-the-wall",
    "deezerArtistId": 10597,
    "artistName": "Roger Waters",
    "title": "Roger Waters: The Wall",
    "year": 2014,
    "filmedYear": 2012,
    "durationSec": 7980,
    "venue": "The Wall Live World Tour",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Stadium"
    ],
    "imdbId": "tt3970482",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMjM5OTM5MTk2OF5BMl5BanBnXkFtZTgwMzEzMjM3NjE@._V1_.jpg",
    "posterWidth": 2016,
    "posterHeight": 2952,
    "summary": "A monumental visual and sonic stadium staging of Pink Floyd's The Wall."
  },
  {
    "slug": "rush-r40-live",
    "deezerArtistId": 8686,
    "artistName": "Rush",
    "title": "R40 Live",
    "year": 2015,
    "filmedYear": 2015,
    "durationSec": 10440,
    "venue": "Air Canada Centre, Toronto",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Classic",
      "Stadium"
    ],
    "imdbId": "tt5821600",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTcxNGJiOWUtYzdmMC00ZWNjLWI4MDctNzYwNzdmN2ZhOTM4XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1035,
    "posterHeight": 1511,
    "summary": "Rush celebrate four decades of progressive rock in their hometown of Toronto, moving backward through their career."
  },
  {
    "slug": "paul-mccartney-rockshow",
    "deezerArtistId": 1446,
    "artistName": "Paul McCartney",
    "title": "Rockshow",
    "year": 1980,
    "filmedYear": 1976,
    "durationSec": 6120,
    "venue": "Wings Over America Tour",
    "genres": [
      "Rock",
      "Pop"
    ],
    "curation": [
      "Classic",
      "Stadium"
    ],
    "imdbId": "tt0079814",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYzI4OWZiYTAtMDhhZC00NTZhLWEyNjQtMjc0YjVmYTBmNmQzXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1000,
    "posterHeight": 1500,
    "summary": "Filmed in 35mm during Paul McCartney & Wings' record-breaking 1976 North American arena tour.",
    "standaloneTitle": true
  },
  {
    "slug": "simon-garfunkel-central-park",
    "deezerArtistId": 2707,
    "artistName": "Simon & Garfunkel",
    "title": "The Concert in Central Park",
    "year": 1982,
    "filmedYear": 1981,
    "durationSec": 5220,
    "venue": "Central Park, New York",
    "genres": [
      "Country & Folk",
      "Rock"
    ],
    "curation": [
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0218896",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMzc3ODJiMjEtMzUyMC00Njg1LTgwM2UtMzJiZjdlNjhjYTU0XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1000,
    "posterHeight": 1500,
    "summary": "Over 500,000 fans gather on the Great Lawn of Central Park for Simon & Garfunkel's landmark reunion concert.",
    "standaloneTitle": true
  },
  {
    "slug": "neil-young-heart-of-gold",
    "deezerArtistId": 1379,
    "artistName": "Neil Young",
    "title": "Heart of Gold",
    "year": 2006,
    "filmedYear": 2005,
    "durationSec": 6180,
    "venue": "Ryman Auditorium, Nashville",
    "genres": [
      "Country & Folk",
      "Rock"
    ],
    "curation": [
      "Unplugged"
    ],
    "imdbId": "tt0473692",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTY2MjUzMTMwOF5BMl5BanBnXkFtZTgwMzI0MDczMjI@._V1_.jpg",
    "posterWidth": 1013,
    "posterHeight": 1500,
    "summary": "Jonathan Demme films Neil Young performing Prairie Wind and career classics at Nashville's Ryman Auditorium."
  },
  {
    "slug": "bob-dylan-dont-look-back",
    "deezerArtistId": 808,
    "artistName": "Bob Dylan",
    "title": "Dont Look Back",
    "year": 1967,
    "filmedYear": 1965,
    "durationSec": 5760,
    "venue": "1965 UK Tour",
    "genres": [
      "Country & Folk",
      "Rock"
    ],
    "curation": [
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0061589",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZjg1NWY2YjctMWZhMi00YmVmLWJlZDgtY2IyMzBlMWQ3ZDI2XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1498,
    "posterHeight": 2256,
    "summary": "D. A. Pennebaker's cinema-verite classic chronicling Bob Dylan's pivotal 1965 acoustic tour of England.",
    "standaloneTitle": true
  },
  {
    "slug": "peter-gabriel-secret-world",
    "deezerArtistId": 1048,
    "artistName": "Peter Gabriel",
    "title": "Secret World Live",
    "year": 1994,
    "filmedYear": 1993,
    "durationSec": 6120,
    "venue": "Palasport, Modena, Italy",
    "genres": [
      "Rock",
      "Pop"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt0111109",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTM4MjU4NTY5Ml5BMl5BanBnXkFtZTcwNzEwNTMyMQ@@._V1_.jpg",
    "posterWidth": 336,
    "posterHeight": 475,
    "summary": "Peter Gabriel's theatrical, Robert Lepage-designed Secret World Tour captured live in Modena.",
    "standaloneTitle": true
  },
  {
    "slug": "oasis-knebworth-1996",
    "deezerArtistId": 927,
    "artistName": "Oasis",
    "title": "Knebworth 1996",
    "year": 2021,
    "filmedYear": 1996,
    "durationSec": 6600,
    "venue": "Knebworth Park, Hertfordshire",
    "genres": [
      "Rock",
      "Indie & Alternative"
    ],
    "curation": [
      "Trending",
      "Festivals",
      "Stadium"
    ],
    "imdbId": "tt15091500",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMzAwYzdmMWUtNWIyZC00ZDc5LWI5NTYtYzVkMjJhZDI4ODdlXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 4147,
    "posterHeight": 6097,
    "summary": "250,000 fans witness Oasis at the absolute apex of Britpop across two historic summer nights at Knebworth."
  },
  {
    "slug": "rhcp-slane-castle",
    "deezerArtistId": 182,
    "artistName": "Red Hot Chili Peppers",
    "title": "Live at Slane Castle",
    "year": 2003,
    "filmedYear": 2003,
    "durationSec": 6120,
    "venue": "Slane Castle, Ireland",
    "genres": [
      "Rock",
      "Indie & Alternative"
    ],
    "curation": [
      "Trending",
      "Festivals",
      "Stadium"
    ],
    "imdbId": "tt0391418",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTI4MzE1NDk4N15BMl5BanBnXkFtZTcwOTc4MjQyMQ@@._V1_.jpg",
    "posterWidth": 336,
    "posterHeight": 475,
    "summary": "An electric 80,000-strong outdoor show on the grounds of Ireland's Slane Castle during the By the Way tour."
  },
  {
    "slug": "muse-rome-olympic-stadium",
    "deezerArtistId": 705,
    "artistName": "Muse",
    "title": "Live at Rome Olympic Stadium",
    "year": 2013,
    "filmedYear": 2013,
    "durationSec": 5880,
    "venue": "Stadio Olimpico, Rome",
    "genres": [
      "Rock",
      "Indie & Alternative"
    ],
    "curation": [
      "Stadium"
    ],
    "imdbId": "tt3411614",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BOTY3MjA3MDA5MF5BMl5BanBnXkFtZTgwNDA0NDA5MDE@._V1_.jpg",
    "posterWidth": 343,
    "posterHeight": 500,
    "summary": "The first concert film shot in 4K Ultra HD, capturing Muse's pyrotechnic stadium spectacle in Rome."
  },
  {
    "slug": "foo-fighters-wembley",
    "deezerArtistId": 566,
    "artistName": "Foo Fighters",
    "title": "Live at Wembley Stadium",
    "year": 2008,
    "filmedYear": 2008,
    "durationSec": 7260,
    "venue": "Wembley Stadium, London",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Stadium"
    ],
    "imdbId": "tt1321823",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMjEwMzUxNDIzMV5BMl5BanBnXkFtZTgwMzEzNTQwNjE@._V1_.jpg",
    "posterWidth": 333,
    "posterHeight": 500,
    "summary": "Foo Fighters command 86,000 fans at Wembley Stadium, joined on stage by Jimmy Page and John Paul Jones."
  },
  {
    "slug": "green-day-bullet-in-a-bible",
    "deezerArtistId": 52,
    "artistName": "Green Day",
    "title": "Bullet in a Bible",
    "year": 2005,
    "filmedYear": 2005,
    "durationSec": 6180,
    "venue": "Milton Keynes Bowl, England",
    "genres": [
      "Rock"
    ],
    "curation": [
      "Festivals",
      "Stadium"
    ],
    "imdbId": "tt0485773",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZWZkOTJjZjQtYjdkYy00MDBkLWIzYWUtYTBjMzIxY2U4ZGU5XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1600,
    "posterHeight": 2400,
    "summary": "Green Day perform American Idiot and career anthems before 130,000 fans at the National Bowl.",
    "standaloneTitle": true
  },
  {
    "slug": "linkin-park-live-in-texas",
    "deezerArtistId": 92,
    "artistName": "Linkin Park",
    "title": "Live in Texas",
    "year": 2003,
    "filmedYear": 2003,
    "durationSec": 4380,
    "venue": "Reliant Stadium & Texas Stadium",
    "genres": [
      "Rock",
      "Metal"
    ],
    "curation": [
      "Trending",
      "Stadium"
    ],
    "imdbId": "tt0404202",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMzA0OTc0NjUxMF5BMl5BanBnXkFtZTcwNDYwNzYxNA@@._V1_.jpg",
    "posterWidth": 335,
    "posterHeight": 475,
    "summary": "High-voltage performances from Houston and Irving during the Summer Sanitarium stadium tour."
  },
  {
    "slug": "pearl-jam-lets-play-two",
    "deezerArtistId": 1319,
    "artistName": "Pearl Jam",
    "title": "Let's Play Two",
    "year": 2017,
    "filmedYear": 2016,
    "durationSec": 7200,
    "venue": "Wrigley Field, Chicago",
    "genres": [
      "Rock",
      "Indie & Alternative"
    ],
    "curation": [
      "Stadium"
    ],
    "imdbId": "tt7435110",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTRkMDMwYzctNDUwNy00MGYwLTkxYjUtNTYxZTUzNGM4ZjYxXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1600,
    "posterHeight": 700,
    "summary": "Pearl Jam's joyous two-night stand at Wrigley Field during the Chicago Cubs' historic 2016 season."
  },
  {
    "slug": "depeche-mode-101",
    "deezerArtistId": 545,
    "artistName": "Depeche Mode",
    "title": "101",
    "year": 1989,
    "filmedYear": 1988,
    "durationSec": 7020,
    "venue": "Rose Bowl, Pasadena",
    "genres": [
      "Electronic",
      "Indie & Alternative"
    ],
    "curation": [
      "Classic",
      "Stadium",
      "Iconic"
    ],
    "imdbId": "tt0094590",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMjA3MDI0OTM2N15BMl5BanBnXkFtZTcwNzk0NDEyMQ@@._V1_.jpg",
    "posterWidth": 349,
    "posterHeight": 475,
    "summary": "D. A. Pennebaker documents Depeche Mode's Music for the Masses tour culminating before 60,000 fans at the Rose Bowl."
  },
  {
    "slug": "the-cure-trilogy",
    "deezerArtistId": 381,
    "artistName": "The Cure",
    "title": "Trilogy: Live in Berlin",
    "year": 2003,
    "filmedYear": 2002,
    "durationSec": 11700,
    "venue": "Tempodrom, Berlin",
    "genres": [
      "Indie & Alternative",
      "Rock"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt0459250",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTc5MzM2NjMxNV5BMl5BanBnXkFtZTcwMjY3OTIyMQ@@._V1_.jpg",
    "posterWidth": 352,
    "posterHeight": 475,
    "summary": "The Cure perform Pornography, Disintegration, and Bloodflowers in full across two unforgettable nights in Berlin."
  },
  {
    "slug": "nin-beside-you-in-time",
    "deezerArtistId": 407,
    "artistName": "Nine Inch Nails",
    "title": "Live: Beside You in Time",
    "year": 2007,
    "filmedYear": 2006,
    "durationSec": 8040,
    "venue": "With Teeth North American Tour",
    "genres": [
      "Rock",
      "Electronic",
      "Indie & Alternative"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt0899161",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTgzNTQzNjA5MF5BMl5BanBnXkFtZTcwMTQ0MTU0MQ@@._V1_.jpg",
    "posterWidth": 367,
    "posterHeight": 500,
    "summary": "Trent Reznor's visceral, visually stunning With Teeth arena production filmed in HD."
  },
  {
    "slug": "lcd-soundsystem-shut-up",
    "deezerArtistId": 642,
    "artistName": "LCD Soundsystem",
    "title": "Shut Up and Play the Hits",
    "year": 2012,
    "filmedYear": 2011,
    "durationSec": 6480,
    "venue": "Madison Square Garden, New York",
    "genres": [
      "Electronic",
      "Indie & Alternative"
    ],
    "curation": [
      "Iconic"
    ],
    "imdbId": "tt2124908",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTQxNjgwMjIzOF5BMl5BanBnXkFtZTcwMjAyNjUwOA@@._V1_.jpg",
    "posterWidth": 810,
    "posterHeight": 1200,
    "summary": "LCD Soundsystem's ecstatic four-hour farewell performance at Madison Square Garden.",
    "standaloneTitle": true
  },
  {
    "slug": "john-mayer-where-the-light-is",
    "deezerArtistId": 598,
    "artistName": "John Mayer",
    "title": "Where the Light Is: Live in Los Angeles",
    "year": 2008,
    "filmedYear": 2007,
    "durationSec": 7800,
    "venue": "Nokia Theatre, Los Angeles",
    "genres": [
      "Rock",
      "Pop"
    ],
    "curation": [
      "Trending",
      "Unplugged"
    ],
    "imdbId": "tt1270491",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZTI0NjgyNmYtNjRmNS00ZmI0LWIwZWEtNGYwZTkzYmMyZWQ4XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 451,
    "posterHeight": 610,
    "summary": "Three distinct live sets in one night: acoustic solo, the John Mayer Trio, and full band.",
    "standaloneTitle": true
  },
  {
    "slug": "stevie-ray-vaughan-el-mocambo",
    "deezerArtistId": 12297,
    "artistName": "Stevie Ray Vaughan",
    "title": "Live at the El Mocambo",
    "year": 1991,
    "filmedYear": 1983,
    "durationSec": 3780,
    "venue": "El Mocambo, Toronto",
    "genres": [
      "Rock",
      "Jazz"
    ],
    "curation": [
      "Classic",
      "Unplugged"
    ],
    "imdbId": "tt0217624",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTI0MjEzMDg0Ml5BMl5BanBnXkFtZTcwNjM4OTkxMQ@@._V1_.jpg",
    "posterWidth": 331,
    "posterHeight": 475,
    "summary": "A ferocious club performance capturing Stevie Ray Vaughan and Double Trouble at their rawest."
  },
  {
    "slug": "metallica-sm",
    "deezerArtistId": 119,
    "artistName": "Metallica",
    "title": "S&M",
    "year": 1999,
    "filmedYear": 1999,
    "durationSec": 8880,
    "venue": "Berkeley Community Theatre",
    "genres": [
      "Metal",
      "Rock"
    ],
    "curation": [
      "Trending",
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0271061",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTA3MTEwMDYzMTBeQTJeQWpwZ15BbWU3MDMyMDM5MTE@._V1_.jpg",
    "posterWidth": 345,
    "posterHeight": 475,
    "summary": "Metallica collaborate with Michael Kamen and the San Francisco Symphony for a groundbreaking orchestral metal concert."
  },
  {
    "slug": "metallica-sm2",
    "deezerArtistId": 119,
    "artistName": "Metallica",
    "title": "S&M2",
    "year": 2019,
    "filmedYear": 2019,
    "durationSec": 9000,
    "venue": "Chase Center, San Francisco",
    "genres": [
      "Metal",
      "Rock"
    ],
    "curation": [
      "Stadium"
    ],
    "imdbId": "tt10765852",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BNGRjYjExODktYWUxNS00ZmMzLWI3MjctMGZlYTU4OGJjODE2XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1200,
    "posterHeight": 1800,
    "summary": "Twenty years after S&M, Metallica reunite with the San Francisco Symphony to open San Francisco's Chase Center."
  },
  {
    "slug": "metallica-through-the-never",
    "deezerArtistId": 119,
    "artistName": "Metallica",
    "title": "Through the Never",
    "year": 2013,
    "filmedYear": 2012,
    "durationSec": 5580,
    "venue": "Rogers Arena, Vancouver",
    "genres": [
      "Metal",
      "Rock"
    ],
    "curation": [
      "Stadium"
    ],
    "imdbId": "tt2172935",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMjQwNjk5MTk4Ml5BMl5BanBnXkFtZTcwNTgwNDA5OQ@@._V1_.jpg",
    "posterWidth": 1383,
    "posterHeight": 2048,
    "summary": "An explosive IMAX concert spectacle blending Metallica's custom 360-degree stage with a surreal narrative."
  },
  {
    "slug": "rammstein-paris",
    "deezerArtistId": 464,
    "artistName": "Rammstein",
    "title": "Rammstein: Paris",
    "year": 2017,
    "filmedYear": 2012,
    "durationSec": 5880,
    "venue": "Palais Omnisports de Paris-Bercy",
    "genres": [
      "Metal",
      "Rock"
    ],
    "curation": [
      "Trending",
      "Stadium"
    ],
    "imdbId": "tt5722116",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMDU4NTkxYmYtMzY4MC00NGIzLWFjYmItY2VlY2VhYmRjZjA1XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 5500,
    "posterHeight": 7778,
    "summary": "Jonas Akerlund transforms Rammstein's pyrotechnic Paris arena shows into a hyper-stylized concert film."
  },
  {
    "slug": "iron-maiden-flight-666",
    "deezerArtistId": 931,
    "artistName": "Iron Maiden",
    "title": "Flight 666",
    "year": 2009,
    "filmedYear": 2008,
    "durationSec": 6720,
    "venue": "Somewhere Back in Time World Tour",
    "genres": [
      "Metal",
      "Rock"
    ],
    "curation": [
      "Stadium"
    ],
    "imdbId": "tt1361558",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZjc5ZGY2M2MtNTI3Zi00MWQwLTlhYzUtMzAzYTM3MGM1YzEyXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1059,
    "posterHeight": 1500,
    "summary": "Iron Maiden fly Bruce Dickinson's customized Boeing 757 across five continents for 23 sold-out stadium concerts."
  },
  {
    "slug": "black-sabbath-the-end",
    "deezerArtistId": 647,
    "artistName": "Black Sabbath",
    "title": "The End of the End",
    "year": 2017,
    "filmedYear": 2017,
    "durationSec": 5700,
    "venue": "Genting Arena, Birmingham",
    "genres": [
      "Metal",
      "Rock"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt7133352",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYWI1MGUyZWYtNDlkNS00ZjM3LWExNmUtMWI4NzhjNWJiYmI0XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 250,
    "posterHeight": 370,
    "summary": "The godfathers of heavy metal take their final bow in their hometown of Birmingham."
  },
  {
    "slug": "slipknot-disasterpieces",
    "deezerArtistId": 117,
    "artistName": "Slipknot",
    "title": "Disasterpieces",
    "year": 2002,
    "filmedYear": 2002,
    "durationSec": 5460,
    "venue": "London Arena, England",
    "genres": [
      "Metal"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt0350815",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYjQ3ZThjMTktNGFkZi00NDlhLThlMGEtNjA3NmRlNWY5MmE2XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 375,
    "posterHeight": 500,
    "summary": "Shot with 30 cameras including mask-mounted rigs during Slipknot's ferocious Iowa tour stop in London."
  },
  {
    "slug": "ghost-rite-here-rite-now",
    "deezerArtistId": 8506054,
    "artistName": "Ghost",
    "title": "Rite Here Rite Now",
    "year": 2024,
    "filmedYear": 2023,
    "durationSec": 8700,
    "venue": "Kia Forum, Inglewood",
    "genres": [
      "Metal",
      "Rock"
    ],
    "curation": [
      "Trending",
      "New & Recent"
    ],
    "imdbId": "tt32260498",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYmQ1ZWYyZGQtN2Q0ZS00ZjJjLWI4YzMtZDVmZjJkNTQ1NGIyXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 2880,
    "posterHeight": 2160,
    "summary": "Filmed over two sold-out nights at the Kia Forum, blending Ghost's theatrical arena show with narrative vignettes.",
    "standaloneTitle": true
  },
  {
    "slug": "taylor-swift-eras-tour",
    "deezerArtistId": 12246,
    "artistName": "Taylor Swift",
    "title": "The Eras Tour",
    "year": 2023,
    "filmedYear": 2023,
    "durationSec": 10140,
    "venue": "SoFi Stadium, Los Angeles",
    "genres": [
      "Pop"
    ],
    "curation": [
      "Trending",
      "New & Recent",
      "Stadium"
    ],
    "imdbId": "tt28814949",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BM2EzMzU3NTEtOWI3NC00N2VjLWFlZTMtMmJjNDc3ZWRjZTk4XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1000,
    "posterHeight": 1470,
    "summary": "Taylor Swift's record-shattering cultural phenomenon captured across three nights at SoFi Stadium.",
    "standaloneTitle": true
  },
  {
    "slug": "taylor-swift-reputation-tour",
    "deezerArtistId": 12246,
    "artistName": "Taylor Swift",
    "title": "Reputation Stadium Tour",
    "year": 2018,
    "filmedYear": 2018,
    "durationSec": 7500,
    "venue": "AT&T Stadium, Arlington",
    "genres": [
      "Pop"
    ],
    "curation": [
      "Stadium"
    ],
    "imdbId": "tt9426852",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BOGUxZDQxNzItYzhmYy00MTkzLTkxOTItZGE3NzAyMTEzOTkzXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 675,
    "posterHeight": 1000,
    "summary": "Pyrotechnics, giant cobras, and stadium anthems from the final US show of the Reputation Stadium Tour."
  },
  {
    "slug": "taylor-swift-folklore-long-pond",
    "deezerArtistId": 12246,
    "artistName": "Taylor Swift",
    "title": "Folklore: The Long Pond Studio Sessions",
    "year": 2020,
    "filmedYear": 2020,
    "durationSec": 6360,
    "venue": "Long Pond Studio, Hudson Valley",
    "genres": [
      "Pop",
      "Indie & Alternative"
    ],
    "curation": [
      "Unplugged"
    ],
    "imdbId": "tt13524234",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BNTc5M2VjYzQtNzMwOS00N2E4LWIyOTctOGNkYjJlYmZhYTQwXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 2700,
    "posterHeight": 4000,
    "summary": "Taylor Swift, Aaron Dessner, and Jack Antonoff perform Folklore in its entirety for the first time together.",
    "standaloneTitle": true
  },
  {
    "slug": "beyonce-homecoming",
    "deezerArtistId": 145,
    "artistName": "Beyoncé",
    "title": "Homecoming: A Film by Beyoncé",
    "year": 2019,
    "filmedYear": 2018,
    "durationSec": 8220,
    "venue": "Coachella, Indio, California",
    "genres": [
      "Pop",
      "R&B & Soul"
    ],
    "curation": [
      "Trending",
      "Festivals",
      "Iconic"
    ],
    "imdbId": "tt10147546",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZDEzODFjZDUtYjFhMy00OTdiLThiMzctYzg5Yjc4ZTVkMmQ3XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1500,
    "posterHeight": 2222,
    "summary": "Beyoncé's historic 2018 Coachella headline performance celebrating HBCU homecoming culture.",
    "standaloneTitle": true
  },
  {
    "slug": "beyonce-renaissance",
    "deezerArtistId": 145,
    "artistName": "Beyoncé",
    "title": "Renaissance: A Film by Beyoncé",
    "year": 2023,
    "filmedYear": 2023,
    "durationSec": 10080,
    "venue": "Renaissance World Tour",
    "genres": [
      "Pop",
      "R&B & Soul"
    ],
    "curation": [
      "Trending",
      "New & Recent",
      "Stadium"
    ],
    "imdbId": "tt29354040",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYjM3YmUzZmQtMTEwMy00ZTMzLTk2NjMtMzdjNWE4YTIwNTk0XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1365,
    "posterHeight": 2048,
    "summary": "The visual and musical triumph of the Renaissance World Tour from Stockholm to Kansas City.",
    "standaloneTitle": true
  },
  {
    "slug": "coldplay-live-2012",
    "deezerArtistId": 892,
    "artistName": "Coldplay",
    "title": "Live 2012",
    "year": 2012,
    "filmedYear": 2012,
    "durationSec": 5520,
    "venue": "Stade de France, Paris & Glastonbury",
    "genres": [
      "Pop",
      "Rock"
    ],
    "curation": [
      "Stadium",
      "Festivals"
    ],
    "imdbId": "tt2471670",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTQxMTY5NDkxM15BMl5BanBnXkFtZTcwMjk5MTE5OA@@._V1_.jpg",
    "posterWidth": 1125,
    "posterHeight": 1600,
    "summary": "Glow-in-the-dark Xylobands light up stadiums across Paris, Montreal, and Glastonbury on the Mylo Xyloto tour."
  },
  {
    "slug": "coldplay-music-of-the-spheres",
    "deezerArtistId": 892,
    "artistName": "Coldplay",
    "title": "Music of the Spheres: Live at River Plate",
    "year": 2023,
    "filmedYear": 2022,
    "durationSec": 8160,
    "venue": "Estadio River Plate, Buenos Aires",
    "genres": [
      "Pop",
      "Rock"
    ],
    "curation": [
      "New & Recent",
      "Stadium"
    ],
    "imdbId": "tt26934645",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BNzEwMmJmMzUtMmNiMC00M2JhLTg5ZjAtNWI5NGZmYThjMGFhXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 8101,
    "posterHeight": 12000,
    "summary": "Coldplay's ecstatic ten-night Buenos Aires stadium residency captured in vibrant cinematic sound."
  },
  {
    "slug": "the-weeknd-sofi-stadium",
    "deezerArtistId": 4050205,
    "artistName": "The Weeknd",
    "title": "Live at SoFi Stadium",
    "year": 2023,
    "filmedYear": 2022,
    "durationSec": 5760,
    "venue": "SoFi Stadium, Los Angeles",
    "genres": [
      "Pop",
      "R&B & Soul"
    ],
    "curation": [
      "Trending",
      "New & Recent",
      "Stadium"
    ],
    "imdbId": "tt26685153",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMDBjYzIyYjktYWI3NC00ZDc5LTliYmYtZjM0ZjNiZGVkOWQxXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1382,
    "posterHeight": 2048,
    "summary": "A moody, cinematic stadium spectacle from the After Hours til Dawn tour in Los Angeles."
  },
  {
    "slug": "billie-eilish-happier-than-ever",
    "deezerArtistId": 9635624,
    "artistName": "Billie Eilish",
    "title": "Happier Than Ever: A Love Letter to Los Angeles",
    "year": 2021,
    "filmedYear": 2021,
    "durationSec": 3900,
    "venue": "Hollywood Bowl, Los Angeles",
    "genres": [
      "Pop",
      "Indie & Alternative"
    ],
    "curation": [
      "Unplugged"
    ],
    "imdbId": "tt15094392",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BNDhhZjQyZmUtNDlkNy00NTNlLTg2YWUtOGEyNjY4OTczMWI1XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 3009,
    "posterHeight": 3736,
    "summary": "Billie Eilish performs Happier Than Ever in order at the Hollywood Bowl with the Los Angeles Philharmonic."
  },
  {
    "slug": "billie-eilish-live-at-the-o2",
    "deezerArtistId": 9635624,
    "artistName": "Billie Eilish",
    "title": "Live at the O2 (Extended Cut)",
    "year": 2023,
    "filmedYear": 2022,
    "durationSec": 5940,
    "venue": "The O2 Arena, London",
    "genres": [
      "Pop",
      "Indie & Alternative"
    ],
    "curation": [
      "New & Recent",
      "Stadium"
    ],
    "imdbId": "tt26348071",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BNGNhNWI1YzItZWU5OS00MTkzLWIyOTEtNDQ0MjI3NWM2MDk5XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 790,
    "posterHeight": 1154,
    "summary": "Captured live in London during the sold-out Happier Than Ever world tour."
  },
  {
    "slug": "lady-gaga-chromatica-ball",
    "deezerArtistId": 75491,
    "artistName": "Lady Gaga",
    "title": "Gaga Chromatica Ball",
    "year": 2024,
    "filmedYear": 2022,
    "durationSec": 7020,
    "venue": "Dodger Stadium, Los Angeles",
    "genres": [
      "Pop"
    ],
    "curation": [
      "Trending",
      "New & Recent",
      "Stadium"
    ],
    "imdbId": "tt29794647",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZTdiMmRmMzAtN2ZmYy00YWJkLTg4NTMtN2UzNmJmZjljNDE1XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 810,
    "posterHeight": 1200,
    "summary": "Lady Gaga commands a sold-out crowd of 52,000 at Dodger Stadium in a bold, brutalist pop spectacle.",
    "standaloneTitle": true
  },
  {
    "slug": "olivia-rodrigo-guts-world-tour",
    "deezerArtistId": 11152580,
    "artistName": "Olivia Rodrigo",
    "title": "GUTS World Tour",
    "year": 2024,
    "filmedYear": 2024,
    "durationSec": 6120,
    "venue": "Intuit Dome, Los Angeles",
    "genres": [
      "Pop",
      "Rock"
    ],
    "curation": [
      "Trending",
      "New & Recent",
      "Stadium"
    ],
    "imdbId": "tt33562156",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYjBlNGZlZjctZDUwYy00OWRkLThhYjYtMGJkMDhjOWNkMzVhXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1170,
    "posterHeight": 1426,
    "summary": "High-energy pop-rock catharsis filmed live at Los Angeles's Intuit Dome on the GUTS World Tour.",
    "standaloneTitle": true
  },
  {
    "slug": "ariana-grande-excuse-me",
    "deezerArtistId": 1562681,
    "artistName": "Ariana Grande",
    "title": "Excuse Me, I Love You",
    "year": 2020,
    "filmedYear": 2019,
    "durationSec": 5820,
    "venue": "The O2 Arena, London",
    "genres": [
      "Pop",
      "R&B & Soul"
    ],
    "curation": [
      "Stadium"
    ],
    "imdbId": "tt13615386",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BOTY1MGE4Y2EtNDVlMi00NWQwLWFmN2YtYmE0NTBkMDQyMjYxXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1013,
    "posterHeight": 1500,
    "summary": "Ariana Grande's Sweetener World Tour hits London's O2 Arena with soaring vocals and backstage moments."
  },
  {
    "slug": "adele-royal-albert-hall",
    "deezerArtistId": 75798,
    "artistName": "Adele",
    "title": "Live at the Royal Albert Hall",
    "year": 2011,
    "filmedYear": 2011,
    "durationSec": 5940,
    "venue": "Royal Albert Hall, London",
    "genres": [
      "Pop",
      "R&B & Soul"
    ],
    "curation": [
      "Unplugged",
      "Iconic"
    ],
    "imdbId": "tt2122272",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMjE3NzY5NjQxMV5BMl5BanBnXkFtZTcwMzk5MTE5OA@@._V1_.jpg",
    "posterWidth": 369,
    "posterHeight": 500,
    "summary": "Adele delivers a powerhouse, career-defining performance of 21 in London's historic Royal Albert Hall."
  },
  {
    "slug": "bts-yet-to-come",
    "deezerArtistId": 6982223,
    "artistName": "BTS",
    "title": "Yet to Come in Cinemas",
    "year": 2023,
    "filmedYear": 2022,
    "durationSec": 6180,
    "venue": "Busan Asiad Main Stadium, South Korea",
    "genres": [
      "Pop"
    ],
    "curation": [
      "New & Recent",
      "Stadium"
    ],
    "imdbId": "tt24807190",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZmM5MjhlNDgtMTczMi00ZDFiLTk3ZmUtYjNlOGQyYTRiZDM2XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1000,
    "posterHeight": 1500,
    "summary": "BTS perform their career-spanning anthems before a massive stadium crowd in Busan."
  },
  {
    "slug": "michael-jackson-bucharest",
    "deezerArtistId": 259,
    "artistName": "Michael Jackson",
    "title": "Live in Bucharest: The Dangerous Tour",
    "year": 1992,
    "filmedYear": 1992,
    "durationSec": 7320,
    "venue": "National Stadium, Bucharest",
    "genres": [
      "Pop",
      "R&B & Soul"
    ],
    "curation": [
      "Classic",
      "Stadium",
      "Iconic"
    ],
    "imdbId": "tt0480827",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTczNzE2MDI2MF5BMl5BanBnXkFtZTgwMDE2OTkwMzE@._V1_.jpg",
    "posterWidth": 333,
    "posterHeight": 500,
    "summary": "The King of Pop's electrifying 1992 Dangerous World Tour stadium show in front of 70,000 fans."
  },
  {
    "slug": "prince-sign-o-the-times",
    "deezerArtistId": 1878,
    "artistName": "Prince",
    "title": "Sign 'o' the Times",
    "year": 1987,
    "filmedYear": 1987,
    "durationSec": 5100,
    "venue": "Paisley Park & Rotterdam",
    "genres": [
      "R&B & Soul",
      "Pop",
      "Rock"
    ],
    "curation": [
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0093970",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZDljYjhmNTMtNzVlZC00NmE4LTliOTUtMWYzYWE5OTkwN2EyXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1764,
    "posterHeight": 2613,
    "summary": "Prince's dazzling, kinetic concert film blending live European tour energy with Paisley Park soundstage sequences.",
    "standaloneTitle": true
  },
  {
    "slug": "sade-bring-me-home",
    "deezerArtistId": 202,
    "artistName": "Sade",
    "title": "Bring Me Home: Live 2011",
    "year": 2012,
    "filmedYear": 2011,
    "durationSec": 6840,
    "venue": "Citizens Business Bank Arena, Ontario",
    "genres": [
      "R&B & Soul",
      "Jazz"
    ],
    "curation": [
      "Unplugged"
    ],
    "imdbId": "tt3509240",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BNjViNWU5Y2EtZTVhYy00ZDk0LThiNmUtN2MzZWFjOGRhZjBiXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1157,
    "posterHeight": 1157,
    "summary": "Sade's lush, elegant return to the stage directed by Sophie Muller."
  },
  {
    "slug": "amy-winehouse-shepherds-bush",
    "deezerArtistId": 9052,
    "artistName": "Amy Winehouse",
    "title": "I Told You I Was Trouble: Live in London",
    "year": 2007,
    "filmedYear": 2007,
    "durationSec": 4380,
    "venue": "Shepherd's Bush Empire, London",
    "genres": [
      "R&B & Soul",
      "Jazz"
    ],
    "curation": [
      "Classic",
      "Unplugged"
    ],
    "imdbId": "tt2023524",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMzY1ZDkzZWQtNzZjYy00ZmNhLWI2NjAtMWQ4MzNiZjU4YmE4XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 592,
    "posterHeight": 841,
    "summary": "Amy Winehouse at her vocal peak performing Back to Black and Frank live in London."
  },
  {
    "slug": "daft-punk-alive-2007",
    "deezerArtistId": 27,
    "artistName": "Daft Punk",
    "title": "Alive 2007",
    "year": 2007,
    "filmedYear": 2007,
    "durationSec": 5040,
    "venue": "Palais Omnisports de Paris-Bercy",
    "genres": [
      "Electronic"
    ],
    "curation": [
      "Trending",
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt32014090",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMWI4NTFkZmEtODQwMC00ZDQ4LWE2YWQtYmM1NTAzMjk3OGM1XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1000,
    "posterHeight": 1500,
    "summary": "Daft Punk's watershed LED-pyramid live tour that reshaped electronic concert production forever."
  },
  {
    "slug": "justice-iris-space-opera",
    "deezerArtistId": 6404,
    "artistName": "Justice",
    "title": "IRIS: A Space Opera by Justice",
    "year": 2019,
    "filmedYear": 2019,
    "durationSec": 3600,
    "venue": "Woman Worldwide Stage",
    "genres": [
      "Electronic"
    ],
    "curation": [
      "Trending"
    ],
    "imdbId": "tt10012964",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZTliMGZiNTQtNTA2OS00NWM4LTllMzYtMTBkZTdlMmViNjczXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 5000,
    "posterHeight": 6667,
    "summary": "A hypnotic, sci-fi live visual reimagining of Justice's Woman Worldwide concert show."
  },
  {
    "slug": "chemical-brothers-dont-think",
    "deezerArtistId": 81,
    "artistName": "The Chemical Brothers",
    "title": "Don't Think",
    "year": 2012,
    "filmedYear": 2011,
    "durationSec": 5400,
    "venue": "Fuji Rock Festival, Japan",
    "genres": [
      "Electronic"
    ],
    "curation": [
      "Festivals"
    ],
    "imdbId": "tt2137916",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BNWZlYmUyM2EtY2NlOS00OGZlLWE3MjktZDY2NzFiYWIxZjcyXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1684,
    "posterHeight": 2381,
    "summary": "Captured with 20 cameras in the middle of a 50,000-person rain-soaked crowd at Japan's Fuji Rock Festival."
  },
  {
    "slug": "fred-again-apple-music-live",
    "deezerArtistId": 76053262,
    "artistName": "Fred again..",
    "title": "Apple Music Live: Fred again..",
    "year": 2025,
    "filmedYear": 2024,
    "durationSec": 4500,
    "venue": "Shrine Expo Hall, Los Angeles",
    "genres": [
      "Electronic"
    ],
    "curation": [
      "Trending",
      "New & Recent"
    ],
    "imdbId": "tt39186198",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BYzFjNGI2ODgtNDNiOC00MWNjLWFhOTktNjcyYTJjMTRiODY3XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1200,
    "posterHeight": 675,
    "summary": "Euphoric, crowd-surrounded electronic catharsis from Fred again..'s landmark live run."
  },
  {
    "slug": "portishead-roseland-nyc",
    "deezerArtistId": 1069,
    "artistName": "Portishead",
    "title": "Roseland NYC Live",
    "year": 1998,
    "filmedYear": 1997,
    "durationSec": 5640,
    "venue": "Roseland Ballroom, New York",
    "genres": [
      "Electronic",
      "Indie & Alternative"
    ],
    "curation": [
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt0133157",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTIyOTkyOTc3M15BMl5BanBnXkFtZTcwMDQzNDcyMQ@@._V1_.jpg",
    "posterWidth": 336,
    "posterHeight": 475,
    "summary": "Portishead backed by a 35-piece orchestra in a spine-tingling trip-hop showcase at Roseland Ballroom."
  },
  {
    "slug": "bjork-biophilia-live",
    "deezerArtistId": 630,
    "artistName": "Björk",
    "title": "Biophilia Live",
    "year": 2014,
    "filmedYear": 2013,
    "durationSec": 5820,
    "venue": "Alexandra Palace, London",
    "genres": [
      "Electronic",
      "Indie & Alternative"
    ],
    "curation": [
      "Iconic"
    ],
    "imdbId": "tt3626442",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTQ5MTg2NDYyNV5BMl5BanBnXkFtZTgwNjExNDc0MjE@._V1_.jpg",
    "posterWidth": 1000,
    "posterHeight": 1463,
    "summary": "Björk merges bespoke instruments, choral arrangements, and natural science visuals at London's Alexandra Palace."
  },
  {
    "slug": "gorillaz-live-in-manchester",
    "deezerArtistId": 14,
    "artistName": "Gorillaz",
    "title": "Demon Days: Live at the Manchester Opera House",
    "year": 2006,
    "filmedYear": 2005,
    "durationSec": 5040,
    "venue": "Manchester Opera House, England",
    "genres": [
      "Electronic",
      "Hip-Hop",
      "Indie & Alternative"
    ],
    "curation": [
      "Classic"
    ],
    "imdbId": "tt0791306",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMTI0MTkzMDk2NV5BMl5BanBnXkFtZTcwODQwODIzMQ@@._V1_.jpg",
    "posterWidth": 333,
    "posterHeight": 500,
    "summary": "Damon Albarn and an all-star cast of collaborators perform Demon Days live in full."
  },
  {
    "slug": "kendrick-lamar-big-steppers-paris",
    "deezerArtistId": 525046,
    "artistName": "Kendrick Lamar",
    "title": "The Big Steppers Tour: Live from Paris",
    "year": 2022,
    "filmedYear": 2022,
    "durationSec": 5700,
    "venue": "Accor Arena, Paris",
    "genres": [
      "Hip-Hop"
    ],
    "curation": [
      "Trending",
      "New & Recent",
      "Stadium"
    ],
    "imdbId": "tt22940628",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZTUyMGE1YjAtMGRjZi00NjRjLWJiNTQtNjZhYjlmN2MxYTk1XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 1080,
    "posterHeight": 1350,
    "summary": "Kendrick Lamar's theatrical, deeply personal arena tour filmed live at Paris's Accor Arena."
  },
  {
    "slug": "miles-davis-montreux",
    "deezerArtistId": 1910,
    "artistName": "Miles Davis",
    "title": "Miles Davis & Quincy Jones: Live at Montreux",
    "year": 1993,
    "filmedYear": 1991,
    "durationSec": 4500,
    "venue": "Montreux Jazz Festival, Switzerland",
    "genres": [
      "Jazz"
    ],
    "curation": [
      "Classic",
      "Festivals"
    ],
    "imdbId": "tt2566560",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BMmQzYzg1NzYtMTc2MC00MDM1LWEwYTAtNjhjN2FiNmQ5MzFiXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 934,
    "posterHeight": 1499,
    "summary": "In one of his final performances, Miles Davis reunites with Quincy Jones to revisit classic Gil Evans orchestral arrangements."
  },
  {
    "slug": "bob-marley-live-at-the-rainbow",
    "deezerArtistId": 719,
    "artistName": "Bob Marley & The Wailers",
    "title": "Live! at the Rainbow",
    "year": 1991,
    "filmedYear": 1977,
    "durationSec": 4440,
    "venue": "Rainbow Theatre, London",
    "genres": [
      "Reggae"
    ],
    "curation": [
      "Classic",
      "Iconic"
    ],
    "imdbId": "tt1254717",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZDY4ZmU5N2UtOGEyNC00Y2FkLWJhYWMtMmMzNDRjYmM3ZjM5XkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 800,
    "posterHeight": 1200,
    "summary": "Bob Marley & The Wailers' joyous 1977 Exodus tour triumph at London's Rainbow Theatre."
  },
  {
    "slug": "hans-zimmer-live-in-prague",
    "deezerArtistId": 1935,
    "artistName": "Hans Zimmer",
    "title": "Live in Prague",
    "year": 2017,
    "filmedYear": 2016,
    "durationSec": 8280,
    "venue": "O2 Arena, Prague",
    "genres": [
      "Classical",
      "Soundtracks"
    ],
    "curation": [
      "Trending",
      "Stadium",
      "Iconic"
    ],
    "imdbId": "tt5732482",
    "posterUrl": "https://m.media-amazon.com/images/M/MV5BZDA2ZWI3YmUtNDAwZC00MTEwLThhMDItYTQ5NzM2ZTZjMmUxXkEyXkFqcGc@._V1_.jpg",
    "posterWidth": 800,
    "posterHeight": 1136,
    "summary": "Hans Zimmer leads a 72-piece orchestra and band through Inception, Interstellar, Gladiator, and The Dark Knight."
  }
];

export function concertExternalId(slug: string): string {
  return `co-${slug}`;
}

const BY_ID = new Map<string, CuratedConcert>();
const BY_ARTIST = new Map<number, CuratedConcert[]>();

for (const c of CURATED_CONCERTS) {
  BY_ID.set(concertExternalId(c.slug), c);
  let list = BY_ARTIST.get(c.deezerArtistId);
  if (!list) {
    list = [];
    BY_ARTIST.set(c.deezerArtistId, list);
  }
  list.push(c);
}

// Keep each artist's concerts ordered newest-first (with Iconic / Trending tie-breaking).
for (const list of BY_ARTIST.values()) {
  list.sort((a, b) => {
    const aIconic = a.curation.includes("Iconic") ? 1 : 0;
    const bIconic = b.curation.includes("Iconic") ? 1 : 0;
    if (b.year !== a.year) return b.year - a.year;
    return bIconic - aIconic;
  });
}

export function getCuratedConcertById(externalId: string): CuratedConcert | null {
  return BY_ID.get(externalId) || null;
}

export function getCuratedConcertsForArtist(deezerArtistId: number): CuratedConcert[] {
  return BY_ARTIST.get(deezerArtistId) || [];
}

export interface ConcertArtistSeed {
  deezerId: number;
  name: string;
  genres: string[];
  era: string;
  classic: boolean;
}

export function getCuratedConcertArtistSeeds(): ConcertArtistSeed[] {
  const seen = new Map<number, ConcertArtistSeed>();
  for (const c of CURATED_CONCERTS) {
    const existing = seen.get(c.deezerArtistId);
    const isClassic = c.curation.includes("Classic") || c.curation.includes("Iconic") || c.filmedYear <= 2005;
    if (!existing) {
      seen.set(c.deezerArtistId, {
        deezerId: c.deezerArtistId,
        name: c.artistName,
        genres: [...c.genres],
        era: decadeOfYear(c.filmedYear || c.year),
        classic: isClassic,
      });
    } else {
      for (const g of c.genres) {
        if (!existing.genres.includes(g)) existing.genres.push(g);
      }
      if (isClassic) existing.classic = true;
    }
  }
  return Array.from(seen.values());
}

/**
 * Compute deterministic rating [7.4 .. 9.6] for curated concerts so Trending, Iconic,
 * Stadium, and Genre shelves sort their marquee shows cleanly to the front.
 */
export function concertRating(c: CuratedConcert): number {
  let r = 8.0;
  if (c.curation.includes("Iconic")) r += 0.9;
  if (c.curation.includes("Trending")) r += 0.5;
  if (c.curation.includes("New & Recent")) r += 0.3;
  if (c.curation.includes("Stadium")) r += 0.1;
  if (c.curation.includes("Classic")) r += 0.1;
  return Math.min(9.7, Math.round(r * 10) / 10);
}

/**
 * Resize Amazon/IMDb poster URLs cleanly to high-res UX1000 while keeping original aspect ratio.
 */
function posterUrlSized(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.includes("m.media-amazon.com/images/") && s.endsWith("._V1_.jpg")) {
    return s.replace("._V1_.jpg", "._V1_FMjpg_UX1000_.jpg");
  }
  return s;
}

export function buildConcertItem(c: CuratedConcert, index = 1): KindItem {
  const id = concertExternalId(c.slug);
  const releaseStr = `${c.year}-06-15`;
  const { unixSec } = parseReleaseDate(releaseStr);
  const decade = decadeOfYear(c.filmedYear || c.year);
  const poster = posterUrlSized(c.posterUrl);
  const posterW = c.posterWidth || 1000;
  const posterH = c.posterHeight || 1500;
  const art: KindArtRef[] = [];
  if (poster) {
    art.push({
      role: "poster",
      url: poster,
      width: posterW,
      height: posterH,
    });
    art.push({
      role: "thumb",
      url: poster,
      width: posterW,
      height: posterH,
    });
  }
  // Never fall back to the parent artist's photo as a concert backdrop: concerts
  // only emit a backdrop when we have genuine landscape artwork for the concert release.
  const still = posterUrlSized(c.backdropUrl || "");
  if (still) {
    art.push({
      role: "backdrop",
      url: still,
      width: c.backdropWidth || 1280,
      height: c.backdropHeight || 720,
    });
  } else if (poster && posterW > posterH) {
    art.push({
      role: "backdrop",
      url: poster,
      width: posterW,
      height: posterH,
    });
  }

  const metaBits: string[] = [];
  if (c.venue) metaBits.push(c.venue);
  if (c.filmedYear && c.filmedYear !== c.year) {
    metaBits.push(`Filmed ${c.filmedYear}`);
  }
  if (c.durationSec > 0) metaBits.push(formatDuration(c.durationSec));

  const summary = c.summary
    ? metaBits.length > 0
      ? `${c.summary} (${metaBits.join(" · ")})`
      : c.summary
    : `${c.artistName} — ${c.title}${metaBits.length > 0 ? ` · ${metaBits.join(" · ")}` : ""}`;

  const fields: Record<string, unknown> = {
    genres: c.genres,
    decade,
    curation: c.curation,
    releaseType: "live",
    artistName: c.artistName,
    duration: c.durationSec,
  };
  if (c.venue) fields.venue = c.venue;
  if (c.imdbId) fields.imdbId = c.imdbId;

  return {
    id,
    level: "concert",
    parentId: `ar-${c.deezerArtistId}`,
    index,
    title: c.title,
    summary,
    year: c.year,
    released: unixSec || undefined,
    rating: concertRating(c),
    playable: true,
    art,
    fields,
    hints: {
      concertId: id,
      slug: c.slug,
      deezerArtistId: c.deezerArtistId,
      artistName: c.artistName,
      concertTitle: c.title,
      year: c.year,
      filmedYear: c.filmedYear,
      durationSec: c.durationSec,
      venue: c.venue,
      imdbId: c.imdbId,
      standaloneTitle: Boolean(c.standaloneTitle),
    },
    etag: `co2-${c.slug}-${c.year}-${c.durationSec}`,
  };
}

/**
 * Search curated concerts locally (0ms, zero network calls) by artist, title, venue, genre, or year.
 */
export function searchCuratedConcerts(query: string, limit = 12): CuratedConcert[] {
  const normQ = normalizeText(query);
  if (!normQ) return [];
  const qTokens = normQ.split(/\s+/).filter((t) => t.length >= 2 && t !== "the" && t !== "and" && t !== "live" && t !== "concert" && t !== "video");
  const allTokens = normQ.split(/\s+/).filter((t) => t.length >= 2);
  const activeTokens = qTokens.length > 0 ? qTokens : allTokens;
  if (activeTokens.length === 0) return [];

  const scored: Array<{ c: CuratedConcert; score: number }> = [];
  for (const c of CURATED_CONCERTS) {
    const hay = normalizeText(`${c.artistName} ${c.title} ${c.venue} ${c.year} ${c.filmedYear} ${c.genres.join(" ")}`);
    const titleNorm = normalizeText(c.title);
    const artistNorm = normalizeText(c.artistName);
    let hits = 0;
    for (const tok of activeTokens) {
      if (hay.includes(tok)) hits++;
    }
    if (hits === 0) continue;
    const ratio = hits / activeTokens.length;
    if (ratio < 0.6) continue;
    let score = ratio * 60 + concertRating(c) * 2;
    if (titleNorm === normQ || artistNorm === normQ) score += 35;
    else if (titleNorm.includes(normQ) || artistNorm.includes(normQ)) score += 20;
    scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.c);
}

interface ImdbSuggestItem {
  id?: string;
  l?: string;
  y?: number;
  qid?: string;
  s?: string;
  i?: { imageUrl?: string; width?: number; height?: number };
}

const VALID_CONCERT_QIDS = new Set(["movie", "tvSpecial", "tvMovie", "video"]);
const CONCERT_KEYWORDS_RE = /\b(?:live|concert|unplugged|tour|stadium|arena|wembley|pompeii|festival|montreux|mtv|hall|bowl|opera|symphony|orchestra|acoustic|in\s+concert|from\s+the\s+basement|broadcast|on\s+stage|at\s+the)\b/i;

/**
 * Dynamic zero-auth concert film discovery via IMDb suggestion endpoint for uncurated artists/queries.
 * Strictly filters to concert films/specials with posters and caches results in KV for 7 days.
 */
export function searchLiveConcerts(
  env: HostEnv,
  cache: KVCache,
  query: string,
  artistContext?: { deezerArtistId: number; artistName: string; genres?: string[] },
  timeoutMs = 650
): CuratedConcert[] {
  const cleanQ = String(query || "").trim();
  if (!cleanQ) return [];

  const cacheKey = `imdb_concert_v1:${normalizeText(cleanQ)}:${artistContext?.deezerArtistId || 0}`;
  const cached = cache.get<CuratedConcert[]>(cacheKey);
  if (cached) return cached;

  const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(cleanQ)}.json`;
  let items: ImdbSuggestItem[] = [];
  try {
    const resp = env.http.fetch({
      method: "GET",
      url,
      headers: {
        "User-Agent": "EtherMusicPlugin/0.2.5 (https://ether.local)",
        Accept: "application/json",
      },
      timeoutMs,
    });
    if (resp.status >= 200 && resp.status < 300 && resp.body) {
      const parsed = JSON.parse(resp.body);
      if (Array.isArray(parsed?.d)) {
        items = parsed.d;
      }
    }
  } catch (err) {
    rethrowHostFault(err);
    return [];
  }

  const results: CuratedConcert[] = [];
  const seenImdb = new Set<string>();
  const normArtist = artistContext ? normalizeText(artistContext.artistName) : "";

  for (const d of items) {
    const imdbId = String(d?.id || "");
    const title = String(d?.l || "").trim();
    const qid = String(d?.qid || "");
    const year = Number(d?.y || 0);
    const posterUrl = String(d?.i?.imageUrl || "").trim();
    if (!imdbId.startsWith("tt") || !title || !posterUrl || seenImdb.has(imdbId)) continue;
    if (!VALID_CONCERT_QIDS.has(qid)) continue;

    // Require concert/live signal in title or query, and match artist if provided.
    const combined = `${title} ${d?.s || ""}`;
    if (!CONCERT_KEYWORDS_RE.test(title) && !CONCERT_KEYWORDS_RE.test(cleanQ)) continue;
    if (normArtist && !normalizeText(combined).includes(normArtist)) continue;

    // Skip if already in curated catalog by IMDb ID
    if (CURATED_CONCERTS.some((c) => c.imdbId === imdbId)) continue;

    seenImdb.add(imdbId);
    const slug = `${imdbId}-${normalizeText(title).replace(/\s+/g, "-").slice(0, 48)}`;
    const artistName = artistContext?.artistName || title.split(":")[0].trim();
    const record: CuratedConcert = {
      slug,
      deezerArtistId: artistContext?.deezerArtistId || 0,
      artistName,
      title,
      year: year || 2020,
      filmedYear: year || 2020,
      durationSec: 5400,
      venue: "",
      genres: artistContext?.genres && artistContext.genres.length > 0 ? artistContext.genres : ["Rock"],
      curation: year >= 2022 ? ["New & Recent"] : [],
      imdbId,
      posterUrl,
      posterWidth: d?.i?.width || 1000,
      posterHeight: d?.i?.height || 1500,
      summary: `${artistName} — ${title}${year ? ` (${year})` : ""} concert film.`,
    };
    results.push(record);
    // Persist dynamic concert metadata in KV so /items/:id and /resolve can load it later.
    cache.set(`concert_meta_v1:${concertExternalId(slug)}`, record, 7 * DAY_MS);
    if (results.length >= 4) break;
  }

  cache.set(cacheKey, results, 7 * DAY_MS);
  return results;
}
