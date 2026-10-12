import { describe, expect, it } from 'vitest';
import { downloadName, photoName } from './format';

describe('photo names', () => {
  it('shows the given name, else the uploaded filename', () => {
    expect(photoName({ display_name: 'Kitchen before', original_name: 'IMG_1.JPG' })).toBe('Kitchen before');
    expect(photoName({ display_name: null, original_name: 'IMG_1.JPG' })).toBe('IMG_1.JPG');
    expect(photoName({ original_name: null })).toBeNull();
  });

  it('downloads under the given name, keeping the file extension', () => {
    expect(downloadName({ display_name: 'Kitchen before', original_name: 'IMG_1.JPG' })).toBe('Kitchen before.JPG');
    expect(downloadName({ display_name: 'Kitchen.jpg', original_name: 'IMG_1.JPG' })).toBe('Kitchen.jpg');
    expect(downloadName({ display_name: 'Kitchen', original_name: 'no-extension' })).toBe('Kitchen');
    expect(downloadName({ display_name: null, original_name: 'IMG_1.JPG' })).toBe('IMG_1.JPG');
  });

  it('downloads an automatic name with the original extension', () => {
    expect(downloadName({ display_name: '3962 – 260923 160432', original_name: 'IMG_4471.HEIC' })).toBe('3962 – 260923 160432.HEIC');
  });

  it('keeps URL-reserved characters out of the download filename', () => {
    expect(downloadName({ display_name: '#3962 – 260923 160432', original_name: 'IMG_1.jpg' })).toBe('-3962 – 260923 160432.jpg');
    expect(downloadName({ display_name: 'A&B?+C', original_name: 'IMG_1.jpg' })).toBe('A-B--C.jpg');
    expect(downloadName({ display_name: null, original_name: 'a&b.jpg' })).toBe('a-b.jpg');
  });
});
