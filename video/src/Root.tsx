import { Composition } from 'remotion';
import { Demo, TOTAL_FRAMES } from './Demo';
import { FPS, H, W } from './theme';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="Demo" component={Demo} durationInFrames={TOTAL_FRAMES} fps={FPS} width={W} height={H} />
    </>
  );
};
