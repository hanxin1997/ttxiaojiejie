/**
 * 轻量级路由器
 * 支持 method + path 匹配，:param 路径参数提取
 * 不依赖任何框架
 */

function pathToRegex(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\//g, '\\/');

  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

export function createRouter() {
  const routes = [];

  function register(method, pattern, handler) {
    const { regex, paramNames } = pathToRegex(pattern);
    routes.push({ method: method.toUpperCase(), regex, paramNames, handler });
  }

  function match(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;

      const m = pathname.match(route.regex);
      if (!m) continue;

      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });

      return { handler: route.handler, params };
    }

    return null;
  }

  return {
    get: (pattern, handler) => register('GET', pattern, handler),
    head: (pattern, handler) => register('HEAD', pattern, handler),
    post: (pattern, handler) => register('POST', pattern, handler),
    put: (pattern, handler) => register('PUT', pattern, handler),
    delete: (pattern, handler) => register('DELETE', pattern, handler),
    match,
  };
}
