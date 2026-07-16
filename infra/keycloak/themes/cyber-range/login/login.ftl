<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>
<!-- template: login.ftl -->

    <#if section = "header">
        登录平台账号
    <#elseif section = "form">
        <div id="kc-form">
            <#if realm.password>
                <form id="kc-form-login" class="cr-login-form" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post" novalidate="novalidate">
                    <#if !usernameHidden??>
                        <div class="cr-form-group">
                            <label class="cr-form-label" for="username">
                                <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
                            </label>
                            <input
                                id="username"
                                name="username"
                                type="text"
                                class="cr-form-input"
                                autocomplete="username"
                                autofocus
                                value="${login.username!''}"
                                aria-invalid="${messagesPerField.existsError('username','password')?c}"
                            />
                        </div>
                    </#if>

                    <div class="cr-form-group">
                        <label class="cr-form-label" for="password">${msg("password")}</label>
                        <input
                            id="password"
                            name="password"
                            type="password"
                            class="cr-form-input"
                            autocomplete="current-password"
                            aria-invalid="${messagesPerField.existsError('username','password')?c}"
                        />
                    </div>

                    <#if messagesPerField.existsError('username','password')>
                        <p class="cr-form-error">${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</p>
                    </#if>

                    <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
                    <button class="cr-login-button" name="login" id="kc-login" type="submit">${msg("doLogIn")}</button>
                </form>
            </#if>
        </div>
    <#elseif section = "info" >
        <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
            <div id="kc-registration-container">
                <div id="kc-registration">
                    <span>${msg("noAccount")} <a href="${url.registrationUrl}">${msg("doRegister")}</a></span>
                </div>
            </div>
        </#if>
    <#elseif section = "socialProviders" >
    </#if>

</@layout.registrationLayout>
