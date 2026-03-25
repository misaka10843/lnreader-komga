import { fetchApi } from '@libs/fetch';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';
import { Plugin } from '@/types/plugin';
import { load as parseHTML } from 'cheerio';
import { storage } from '@libs/storage';

class KomgaPlugin implements Plugin.PluginBase {
  id = 'komga';
  name = 'Komga';
  icon = 'src/multi/komga/icon.png';
  version = '1.0.3';

  site: string = '';
  private email = '';
  private password = '';

  resolveUrl(path: string, isNovel?: boolean): string {
    const baseUrl = this.site || storage.get('url') || '';
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const relative = path.startsWith('/') ? path.substring(1) : path;
    return base + relative;
  }

  private updateConfig() {
    const url = storage.get('url') || '';
    this.site = url.endsWith('/') ? url : url + '/';
    this.email = storage.get('email') || '';
    this.password = storage.get('password') || '';
  }

  async makeRequest(url: string): Promise<string> {
    this.updateConfig();
    const auth = this.btoa(`${this.email}:${this.password}`);

    return await fetchApi(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=utf-8',
        'Authorization': `Basic ${auth}`,
      },
      Referer: this.site,
    }).then(res => res.text());
  }

  btoa(input = '') {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    let output = '';
    for (let block = 0, charCode, i = 0, map = chars; input.charAt(i | 0) || ((map = '='), i % 1); output += map.charAt(63 & (block >> (8 - (i % 1) * 8)))) {
      charCode = input.charCodeAt((i += 3 / 4));
      if (charCode > 0xff) throw new Error("'btoa' failed");
      block = (block << 8) | charCode;
    }
    return output;
  }

  flattenArray(arr: any[]) {
    return arr.reduce((acc: any[], obj: any) => {
      const { children, ...rest } = obj;
      acc.push(rest);
      if (children) acc.push(...this.flattenArray(children));
      return acc;
    }, []);
  }

  async getSeries(url: string): Promise<Plugin.NovelItem[]> {
    const response = await this.makeRequest(url);
    const data = JSON.parse(response);
    const series = data.content || [];

    return series.map((s: any) => ({
      name: s.name,
      path: `api/v1/series/${s.id}`,
      cover: this.resolveUrl(`api/v1/series/${s.id}/thumbnail`),
    }));
  }

  async popularNovels(
    pageNo: number,
    { showLatestNovels, filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    this.updateConfig();
    const read_status = filters?.read_status.value ? '&read_status=' + filters.read_status.value : '';
    const status = filters?.status.value ? '&status=' + filters.status.value : '';
    const sort = showLatestNovels ? 'lastModified,desc' : 'name,asc';

    const url = `${this.site}api/v1/series?page=${pageNo - 1}${read_status}${status}&sort=${sort}`;
    return await this.getSeries(url);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    this.updateConfig();
    const response = await this.makeRequest(this.resolveUrl(novelPath));
    const series = JSON.parse(response);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: series.name,
      cover: this.resolveUrl(`api/v1/series/${series.id}/thumbnail`),
      summary: series.metadata.summary || series.booksMetadata.summary,
      genres: series.metadata.genres.join(','),
      author: series.booksMetadata.authors
        ?.filter((a: any) => a.role === 'writer')
        ?.map((a: any) => a.name)
        ?.join(', ') || '',
    };

    const statusMapping: Record<string, string | undefined> = {
      'ENDED': NovelStatus.Completed,
      'ONGOING': NovelStatus.Ongoing,
      'ABANDONED': NovelStatus.Cancelled,
      'HIATUS': NovelStatus.OnHiatus,
    };
    novel.status = statusMapping[series.metadata.status] || NovelStatus.Unknown;

    const chapters: Plugin.ChapterItem[] = [];
    const booksResponse = await this.makeRequest(this.resolveUrl(`api/v1/series/${series.id}/books?unpaged=true`));
    const booksData = JSON.parse(booksResponse).content;

    for (const book of booksData) {
      const manifestRes = await this.makeRequest(this.resolveUrl(`opds/v2/books/${book.id}/manifest`));
      const manifest = JSON.parse(manifestRes);
      const toc = this.flattenArray(manifest.toc || []);

      const volRaw = book.metadata?.number || manifest.metadata?.belongsTo?.series?.[0]?.position || '1';
      const volNum = String(volRaw).padStart(2, '0');

      let i = 1;
      for (const page of manifest.readingOrder) {
        const tocItem = toc.find((v: any) => v.href?.split('#')[0] === page.href);
        const title = tocItem ? tocItem.title : null;

        const chapterName = `[第 ${volNum} 卷] ${String(i).padStart(2, '0')}/${manifest.readingOrder.length}${title ? ' - ' + title : ''}`;

        chapters.push({
          name: chapterName,
          path: 'opds/v2' + page.href?.split('opds/v2').pop(),
        });
        i++;
      }
    }

    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    this.updateConfig();
    const url = this.resolveUrl(chapterPath);
    const chapterText = await this.makeRequest(url);
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    return this.addUrlToImageHref(chapterText, baseUrl);
  }

  addUrlToImageHref(htmlString: string, baseUrl: string): string {
    const $ = parseHTML(htmlString, { xmlMode: true });

    $('svg image, img').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || $el.attr('xlink:href') || $el.attr('src');

      if (href) {
        const src = href.startsWith('http') ? href : `${baseUrl}${href}`;
        if (el.name === 'image') {
          const img = $('<img />').attr('src', src);
          const w = $el.attr('width');
          const h = $el.attr('height');
          if (w) img.attr('width', w);
          if (h) img.attr('height', h);
          $el.closest('svg').replaceWith(img);
        } else {
          $el.attr('src', src);
        }
      }
    });

    $('a').each((_, a) => {
      const $a = $(a);
      $a.replaceWith($a.text());
    });

    return $.xml();
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    this.updateConfig();
    const url = `${this.site}api/v1/series?search=${searchTerm}&page=${pageNo - 1}`;
    return await this.getSeries(url);
  }

  filters = {
    status: {
      value: '',
      label: 'Status',
      options: [
        { label: 'All', value: '' },
        { label: 'Completed', value: NovelStatus.Completed },
        { label: 'Ongoing', value: NovelStatus.Ongoing },
        { label: 'Cancelled', value: NovelStatus.Cancelled },
        { label: 'OnHiatus', value: NovelStatus.OnHiatus },
      ],
      type: FilterTypes.Picker,
    },
    read_status: {
      value: '',
      label: 'Read status',
      options: [
        { label: 'All', value: '' },
        { label: 'Unread', value: 'UNREAD' },
        { label: 'Read', value: 'READ' },
        { label: 'In progress', value: 'IN_PROGRESS' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;

  pluginSettings = {
    email: { value: '', label: 'Email', type: 'Text' as const },
    password: { value: '', label: 'Password', type: 'Text' as const },
    url: { value: '', label: 'URL', type: 'Text' as const },
  };
}

export default new KomgaPlugin();