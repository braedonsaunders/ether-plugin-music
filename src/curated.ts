// Curated genre taxonomy and verified iconic/classic artist seeds.
// All Deezer artist IDs below have been verified directly against api.deezer.com.

export interface GenreChartSource {
  deezerGenreId: number;
  label: string;
  curationTag: string;
}

export const GENRE_CHARTS: GenreChartSource[] = [
  { deezerGenreId: 132, label: "Pop", curationTag: "chart-pop" },
  { deezerGenreId: 152, label: "Rock", curationTag: "chart-rock" },
  { deezerGenreId: 116, label: "Hip-Hop", curationTag: "chart-hip-hop" },
  { deezerGenreId: 106, label: "Electronic", curationTag: "chart-electronic" },
  { deezerGenreId: 85, label: "Indie & Alternative", curationTag: "chart-indie" },
  { deezerGenreId: 165, label: "R&B & Soul", curationTag: "chart-rnb" },
  { deezerGenreId: 129, label: "Jazz", curationTag: "chart-jazz" },
  { deezerGenreId: 464, label: "Metal", curationTag: "chart-metal" },
  { deezerGenreId: 84, label: "Country & Folk", curationTag: "chart-country" },
  { deezerGenreId: 98, label: "Classical", curationTag: "chart-classical" },
];

export const GENRE_TO_DEEZER_ID: Record<string, number> = {
  "Pop": 132,
  "Rock": 152,
  "Hip-Hop": 116,
  "Electronic": 106,
  "Indie & Alternative": 85,
  "R&B & Soul": 165,
  "Jazz": 129,
  "Metal": 464,
  "Country & Folk": 84,
  "Classical": 98,
  "Reggae": 144,
  "Latin": 197,
  "Soundtracks": 173,
};

export interface IconicArtistSeed {
  deezerId: number;
  name: string;
  genres: string[];
  era: string;
  classic?: boolean;
}

/**
 * Curated cross-genre & cross-era artists so Artists, Albums, Classic Albums,
 * Genres, and Eras feel rich and curated from the very first launch (not an A-Z dump).
 */
export const ICONIC_ARTISTS: IconicArtistSeed[] = [
  // Rock & Classic
  { deezerId: 860, name: "Pink Floyd", genres: ["Rock"], era: "1970s", classic: true },
  { deezerId: 399, name: "Radiohead", genres: ["Rock", "Indie & Alternative"], era: "1990s", classic: true },
  { deezerId: 169, name: "Fleetwood Mac", genres: ["Rock", "Pop"], era: "1970s", classic: true },
  { deezerId: 1, name: "The Beatles", genres: ["Rock", "Pop"], era: "1960s", classic: true },
  { deezerId: 997, name: "David Bowie", genres: ["Rock", "Pop"], era: "1970s", classic: true },
  { deezerId: 415, name: "Nirvana", genres: ["Rock", "Indie & Alternative"], era: "1990s", classic: true },
  { deezerId: 848, name: "Led Zeppelin", genres: ["Rock"], era: "1970s", classic: true },
  { deezerId: 115, name: "AC/DC", genres: ["Rock"], era: "1980s", classic: true },
  { deezerId: 412, name: "Queen", genres: ["Rock", "Pop"], era: "1970s", classic: true },
  { deezerId: 1182, name: "Arctic Monkeys", genres: ["Rock", "Indie & Alternative"], era: "2000s", classic: true },
  { deezerId: 134790, name: "Tame Impala", genres: ["Indie & Alternative", "Rock"], era: "2010s" },
  // Electronic
  { deezerId: 27, name: "Daft Punk", genres: ["Electronic"], era: "2000s", classic: true },
  { deezerId: 580, name: "Aphex Twin", genres: ["Electronic"], era: "1990s", classic: true },
  { deezerId: 612, name: "Massive Attack", genres: ["Electronic"], era: "1990s", classic: true },
  { deezerId: 6404, name: "Justice", genres: ["Electronic"], era: "2000s", classic: true },
  { deezerId: 1069, name: "Portishead", genres: ["Electronic", "Indie & Alternative"], era: "1990s", classic: true },
  { deezerId: 1098, name: "Boards of Canada", genres: ["Electronic"], era: "1990s", classic: true },
  // Hip-Hop
  { deezerId: 525046, name: "Kendrick Lamar", genres: ["Hip-Hop"], era: "2010s", classic: true },
  { deezerId: 73, name: "Nas", genres: ["Hip-Hop"], era: "1990s", classic: true },
  { deezerId: 2857, name: "MF DOOM", genres: ["Hip-Hop"], era: "2000s", classic: true },
  { deezerId: 9, name: "Outkast", genres: ["Hip-Hop"], era: "2000s", classic: true },
  { deezerId: 1194083, name: "Tyler, The Creator", genres: ["Hip-Hop"], era: "2010s" },
  // R&B & Soul
  { deezerId: 1350335, name: "Frank Ocean", genres: ["R&B & Soul"], era: "2010s", classic: true },
  { deezerId: 166, name: "Stevie Wonder", genres: ["R&B & Soul", "Pop"], era: "1970s", classic: true },
  { deezerId: 1878, name: "Prince", genres: ["R&B & Soul", "Pop", "Rock"], era: "1980s", classic: true },
  { deezerId: 9052, name: "Amy Winehouse", genres: ["R&B & Soul", "Jazz"], era: "2000s", classic: true },
  { deezerId: 1154, name: "Marvin Gaye", genres: ["R&B & Soul"], era: "1970s", classic: true },
  { deezerId: 5531258, name: "SZA", genres: ["R&B & Soul"], era: "2020s" },
  // Jazz
  { deezerId: 1910, name: "Miles Davis", genres: ["Jazz"], era: "1960s", classic: true },
  { deezerId: 2449, name: "John Coltrane", genres: ["Jazz"], era: "1960s", classic: true },
  { deezerId: 744, name: "Nina Simone", genres: ["Jazz", "R&B & Soul"], era: "1960s", classic: true },
  { deezerId: 1406, name: "Herbie Hancock", genres: ["Jazz"], era: "1970s", classic: true },
  { deezerId: 5196129, name: "Kamasi Washington", genres: ["Jazz"], era: "2010s" },
  // Pop & Indie
  { deezerId: 630, name: "Björk", genres: ["Electronic", "Indie & Alternative", "Pop"], era: "1990s", classic: true },
  { deezerId: 1049, name: "Kate Bush", genres: ["Pop", "Indie & Alternative"], era: "1980s", classic: true },
  { deezerId: 181, name: "Talking Heads", genres: ["Rock", "Indie & Alternative"], era: "1980s", classic: true },
  { deezerId: 1424821, name: "Lana Del Rey", genres: ["Pop", "Indie & Alternative"], era: "2010s" },
  { deezerId: 9635624, name: "Billie Eilish", genres: ["Pop", "Indie & Alternative"], era: "2020s" },
  { deezerId: 1462230, name: "Charli xcx", genres: ["Pop", "Electronic"], era: "2020s" },
  // Metal & Country / Folk
  { deezerId: 119, name: "Metallica", genres: ["Metal", "Rock"], era: "1980s", classic: true },
  { deezerId: 689, name: "TOOL", genres: ["Metal", "Rock"], era: "2000s", classic: true },
  { deezerId: 647, name: "Black Sabbath", genres: ["Metal", "Rock"], era: "1970s", classic: true },
  { deezerId: 405, name: "Johnny Cash", genres: ["Country & Folk"], era: "1960s", classic: true },
  { deezerId: 74444, name: "Fleet Foxes", genres: ["Country & Folk", "Indie & Alternative"], era: "2000s" },
  { deezerId: 78668, name: "Bon Iver", genres: ["Country & Folk", "Indie & Alternative"], era: "2010s" },
];

export const DECADE_QUERIES: Record<string, string[]> = {
  "2020s": ["2025", "2024", "2023", "2022"],
  "2010s": ["Kendrick Lamar", "Frank Ocean", "Tame Impala", "Lana Del Rey", "Arctic Monkeys"],
  "2000s": ["Daft Punk", "Radiohead", "Outkast", "Amy Winehouse", "Justice"],
  "1990s": ["Nirvana", "Nas", "Massive Attack", "Portishead", "Bjork"],
  "1980s": ["Prince", "Kate Bush", "Talking Heads", "Metallica", "The Smiths"],
  "1970s": ["Pink Floyd", "Fleetwood Mac", "David Bowie", "Stevie Wonder", "Marvin Gaye"],
  "1960s": ["The Beatles", "Miles Davis", "John Coltrane", "Nina Simone", "Johnny Cash"],
  "Classic": ["Miles Davis", "Nina Simone", "Frank Sinatra", "Johnny Cash"],
};
