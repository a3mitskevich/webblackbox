export declare const PLAYER_VIDEOS_DIR: string;
export declare const PLAYER_VIDEOS_METADATA: string;
export declare const GUIDE_VIDEO_IDS: readonly string[];

export type GuideVideo = {
  id: string;
  lang: string;
  file: string;
  size: number;
};

export declare function findGuideVideos(videosDir: string): Promise<GuideVideo[]>;

export declare function bundleVideosIntoPlayer(options: {
  videosDir: string;
  playerBuildDir: string;
}): Promise<{ bundled: boolean; videos: GuideVideo[] }>;
