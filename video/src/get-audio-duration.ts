import { ALL_FORMATS, Input, UrlSource } from 'mediabunny';

export const getAudioDuration = async (src: string) => {
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(src, { getRetryDelay: () => null }) });
  return input.computeDuration();
};
