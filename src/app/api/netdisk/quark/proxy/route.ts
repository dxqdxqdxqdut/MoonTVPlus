import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { ensureQuarkPlayFolder, getQuarkPlayHeaders, getQuarkPlayUrls, saveQuarkShareFile } from '@/lib/netdisk/quark.client';
import { refreshQuarkNetdiskSession } from '@/lib/netdisk/quark-session-cache';
import { resolveQuarkSession } from '@/lib/netdisk/quark-session-resolver';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo?.username) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const episodeIndexRaw = searchParams.get('episodeIndex');
    const quality = searchParams.get('quality') || '';
    if (!id || episodeIndexRaw == null) {
      return NextResponse.json({ error: '缺少参数' }, { status: 400 });
    }

    const episodeIndex = Number.parseInt(episodeIndexRaw, 10);
    if (!Number.isInteger(episodeIndex) || episodeIndex < 0) {
      return NextResponse.json({ error: '无效的 episodeIndex' }, { status: 400 });
    }

    const { session, cookie, savePath } = await resolveQuarkSession(id);
    const file = session.files[episodeIndex];
    if (!file) {
      return NextResponse.json({ error: '播放文件不存在' }, { status: 404 });
    }

    if (!session.playFolderFid || !session.playFolderPath) {
      const folder = await ensureQuarkPlayFolder(cookie, savePath, session.shareId, session.title);
      session.playFolderFid = folder.folderFid;
      session.playFolderPath = folder.folderPath;
    }

    let savedFileId = session.savedFileIds[file.fid];
    if (!savedFileId) {
      savedFileId = await saveQuarkShareFile(cookie, {
        shareId: session.shareId,
        shareToken: session.shareToken,
        fileId: file.fid,
        shareFileToken: file.shareFidToken,
        playFolderFid: session.playFolderFid,
      });
      session.savedFileIds[file.fid] = savedFileId;
    }
    refreshQuarkNetdiskSession(id);

    const playUrls = await getQuarkPlayUrls(cookie, savedFileId);
    const selected = playUrls.find((item) => item.name === quality) || playUrls[0];
    if (!selected) {
      return NextResponse.json({ error: '未获取到夸克播放地址' }, { status: 500 });
    }

    const range = request.headers.get('range');
    const upstream = await fetch(selected.url, {
      headers: {
        ...getQuarkPlayHeaders(cookie),
        ...(range ? { Range: range } : {}),
      },
      cache: 'no-store',
    });

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `夸克视频代理失败 (${upstream.status})` },
        { status: upstream.status || 500 }
      );
    }

    const responseHeaders = new Headers();
    const copyHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    copyHeaders.forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    });
    responseHeaders.set('Cache-Control', 'private, no-store');

    return new Response(upstream.body, {
      status: range && upstream.headers.get('content-range') ? 206 : 200,
      headers: responseHeaders,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '夸克网盘代理失败' },
      { status: 500 }
    );
  }
}
