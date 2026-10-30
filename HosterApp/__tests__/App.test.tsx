/**
 * @format
 */

import 'react-native';
import React from 'react';
import {Platform, NativeModules, Linking} from 'react-native';
import {it, describe, expect, beforeEach, afterEach, jest} from '@jest/globals';
import renderer, {act} from 'react-test-renderer';

jest.mock('nodejs-mobile-react-native', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    channel: {addListener: jest.fn(), removeListener: jest.fn()},
  },
}));

jest.mock('react-native-webview', () => {
  const R = require('react');
  const {View} = require('react-native');
  // a class, like the real WebView (function components can't take refs)
  class WebView extends R.Component<any> {
    render() {
      return R.createElement(View, {testID: 'webview', ...this.props});
    }
  }
  return {WebView};
});

const flush = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r));
  });
};

const runningStatus = {
  running: true,
  url: 'http://hoster.local:8080',
  localUrl: 'http://192.168.1.5:8080',
  devices: 2,
};

const native = {
  start: jest.fn(async () => true),
  stop: jest.fn(async () => true),
  hasAllFilesAccess: jest.fn(async () => true),
  openAllFilesSettings: jest.fn(),
  isIgnoringBatteryOptimizations: jest.fn(async () => true),
  requestIgnoreBatteryOptimizations: jest.fn(),
};
// App captures NativeModules.HosterService when it loads, so set it first.
(NativeModules as any).HosterService = native;
const App: React.ComponentType = require('../App').default;

describe('Hoster app', () => {
  beforeEach(() => {
    Object.values(native).forEach(f => (f as any).mockClear());
    (Platform as any).OS = 'android';
    (Platform as any).Version = 33;
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  it('shows the starting screen first', async () => {
    // server never answers: behave like real fetch and reject when the app aborts after its timeout
    (global as any).fetch = jest.fn(
      (_url: string, init?: {signal?: AbortSignal}) =>
        new Promise((_res, rej) =>
          init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<App />);
    });
    expect(JSON.stringify(tree.toJSON())).toContain('Starting Hoster');
    await act(async () => tree.unmount());
  });

  it('loads the Host UI once the server answers, and starts the foreground service while sharing', async () => {
    (global as any).fetch = jest.fn(async () => ({ok: true, json: async () => runningStatus}));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<App />);
    });
    await flush();
    await flush();

    expect(tree.root.findByProps({testID: 'webview'}).props.source.uri).toBe(
      'http://127.0.0.1:9090/host',
    );
    expect(native.start).toHaveBeenCalledTimes(1);
    const [title, text] = (native.start.mock.calls[0] as unknown) as [string, string];
    expect(title).toBe('Hoster is sharing');
    expect(text).toContain('http://hoster.local:8080');
    expect(text).toContain('IP: http://192.168.1.5:8080');
    expect(text).toContain('2 devices active');
    await act(async () => tree.unmount());
  });

  it('only opens external links outside the app', async () => {
    (global as any).fetch = jest.fn(async () => ({ok: true, json: async () => runningStatus}));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<App />);
    });
    await flush();
    await flush();
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    try {
      const guard = tree.root.findByProps({testID: 'webview'}).props.onShouldStartLoadWithRequest;
      expect(guard({url: 'http://127.0.0.1:9090/host'})).toBe(true);
      expect(guard({url: 'http://localhost:9090/api/status'})).toBe(true);
      expect(open).not.toHaveBeenCalled();
      expect(guard({url: 'https://example.com/page'})).toBe(false);
      expect(open).toHaveBeenCalledWith('https://example.com/page');
    } finally {
      open.mockRestore();
      await act(async () => tree.unmount());
    }
  });
});
