<#import "field.ftl" as field>
<#import "footer.ftl" as loginFooter>
<#macro username>
</#macro>

<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}" lang="${lang}"<#if realm.internationalizationEnabled> dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="robots" content="noindex, nofollow">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${msg("loginTitle",(realm.displayName!''))}</title>
    <link rel="icon" href="${url.resourcesPath}/img/favicon.ico" />
    <#if properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <script type="module">
        import { startSessionPolling } from "${url.resourcesPath}/js/authChecker.js";
        startSessionPolling("${url.ssoLoginInOtherTabsUrl?no_esc}");
    </script>
    <#if authenticationSession??>
        <script type="module">
            import { checkAuthSession } from "${url.resourcesPath}/js/authChecker.js";
            checkAuthSession("${authenticationSession.authSessionIdHash}");
        </script>
    </#if>
</head>
<body id="keycloak-bg" class="${properties.kcBodyClass!}">
<div class="cr-login-shell">
  <div class="cr-login-wrap">
    <main class="cr-login-card">
      <header id="kc-header" class="cr-login-copy">
        <span class="cr-login-eyebrow">平台账号认证</span>
        <div class="cr-login-title-row">
          <img
            alt=""
            aria-hidden="true"
            class="cr-login-title-mark"
            height="31"
            src="${url.resourcesPath}/img/platform-mark.svg"
            width="31"
          />
          <h1 id="kc-page-title" class="cr-login-title"><#nested "header"></h1>
        </div>
        <p class="cr-login-subtitle">使用平台账号继续进入综合靶场管理工作台。</p>
      </header>

      <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
          <div class="cr-alert cr-alert-${(message.type = 'error')?then('danger', message.type)}">
              <span class="cr-alert-text">${kcSanitize(message.summary)?no_esc}</span>
          </div>
      </#if>

      <#nested "form">

      <#if displayInfo>
        <div id="kc-info" class="cr-login-info">
            <div id="kc-info-wrapper">
                <#nested "info">
            </div>
        </div>
      </#if>
    </main>

    <@loginFooter.content/>
  </div>
</div>
</body>
</html>
</#macro>
