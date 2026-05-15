import play from "play-dl";

export interface PlayDlResult {
  title: string;
  url: string;
}

interface PlayDlSearchResult {
  title?: string;
  url?: string;
}

interface SpotifyTrackLike {
  type?: string;
  name?: string;
  artists?: Array<{ name?: string }>;
}

type SearchFunction = (
  query: string,
  options: { limit: number },
) => Promise<PlayDlSearchResult[]>;

type SpotifyFunction = (url: string) => Promise<SpotifyTrackLike>;

export interface PlayDlDependencies {
  search?: SearchFunction;
  spotify?: SpotifyFunction;
}

export function createPlayDlResolver(dependencies: PlayDlDependencies = {}) {
  const search: SearchFunction = dependencies.search ?? play.search;
  const spotify: SpotifyFunction =
    dependencies.spotify ?? (play.spotify as SpotifyFunction);

  return {
    async searchYouTube(query: string): Promise<PlayDlResult> {
      const results = await search(query, { limit: 1 });
      const first = results[0];
      if (!first?.url) throw new Error(`No YouTube result found for ${query}`);
      return {
        title: first.title || query,
        url: first.url,
      };
    },

    async resolveSpotifyTrack(url: string): Promise<PlayDlResult> {
      const track = await spotify(url);
      if (track.type !== "track") {
        throw new Error("Only Spotify track URLs are supported");
      }
      const artists = (track.artists || [])
        .map((artist) => artist.name)
        .filter(Boolean)
        .join(" ");
      const query = `${artists} ${track.name || ""} audio`.trim();
      return this.searchYouTube(query);
    },
  };
}
