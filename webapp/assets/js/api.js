const API = (() => {
  const module = {};

  // initialize with a default server
  module.servers = [{
    name: "default",
    url: '..', // This is some hacky bullshit to get relative URLs working
    token: localStorage.getItem('token')
  }];

  module.selectedServer = 0;

  module.name = () => {
    return module.servers[module.selectedServer].name;
  }

  module.token = () => {
    return module.servers[module.selectedServer].token;
  }

  module.url = () => {
    return module.servers[module.selectedServer].url;
  }

  module.logout = () => {
    try { new BroadcastChannel('velvet').postMessage({ type: 'logout' }); } catch(e) {}
    localStorage.removeItem('token');
    localStorage.removeItem('ms2_token');
    Cookies.remove('x-access-token');
    document.location.assign(window.location.origin + '/');
  }

  module.goToPlayer = () => {
    window.location.assign(window.location.origin + '/');
  }

  module.axios = axios.create();

  // Always attach the latest token so a page refresh after login never sends null
  module.axios.interceptors.request.use(config => {
    const tok = module.token() || localStorage.getItem('ms2_token');
    if (tok) { config.headers['x-access-token'] = tok; }
    return config;
  });

  return module;
})();