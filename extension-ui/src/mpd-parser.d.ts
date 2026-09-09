declare module "mpd-parser" {
  export function stringToMpdXml(text: string): Element;
  export function inheritAttributes(root: Element, options: { manifestUri: string }): { representationInfo: MpdRepresentation[] };
  export function toPlaylists(representations: MpdRepresentation[]): MpdPlaylist[];
  export interface MpdRepresentation {
    attributes: Record<string, any>;
    segmentInfo: { template?: Record<string, any>; list?: Record<string, any>; base?: Record<string, any>; segmentTimeline?: Record<string, number>[] };
  }
  export interface MpdPlaylist {
    attributes: Record<string, any>;
    segments?: { resolvedUri: string; duration: number; presentationTime: number; byterange?: { offset: number; length: number }; map?: { resolvedUri: string; byterange?: { offset: number; length: number } } }[];
    sidx?: unknown;
  }
}
